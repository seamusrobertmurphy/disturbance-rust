//! The SOP's practical lessons, checked on every run so they do not depend
//! on recall. Ported from `src/diagnostics.ts` in disturbance-checker-srm
//! 0.14.3.
//!
//! One change. The checker's long-tail message gives the share of pixels at
//! or above the Low break. That share is an area of spectral change, which a
//! check never states before ground truthing, so the message names the shape
//! and leaves the share out.

use serde::Serialize;

use crate::defaults::{Breaks, DeltaId};
use crate::deltas::Histogram;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Info,
    Warning,
}

#[derive(Clone, Debug, Serialize)]
pub struct Diagnostic {
    pub severity: Severity,
    pub title: String,
    pub detail: String,
    /// The SOP section the rule comes from, shown in the run record.
    pub source: String,
}

fn diagnostic(severity: Severity, title: String, detail: String, source: &str) -> Diagnostic {
    Diagnostic { severity, title, detail, source: source.into() }
}

/// What the histogram's shape says, SOP Step 6.
#[derive(Clone, Debug, Serialize)]
pub struct HistogramAnalysis {
    /// "unimodal-narrow", "bimodal-gap", "unimodal-long-tail" or "empty".
    pub shape: &'static str,
    /// The centre of the gap, offered as a Low break, for the bimodal shape.
    pub suggested_low: Option<f64>,
    pub diagnostics: Vec<Diagnostic>,
}

fn mass_at_or_above(h: &Histogram, threshold: f64) -> u64 {
    h.starts.iter().zip(&h.counts).filter(|(s, _)| **s >= threshold).map(|(_, c)| c).sum()
}

/// The checker's `analyseHistogram`, on the breaks the operator set (before
/// any scene-wide shift).
///
/// Unimodal at 0 with a narrow tail means noise or phenology, and the defaults
/// hold. Bimodal with a gap means real signal, and Low belongs in the gap. A
/// long unimodal right tail with no gap means a contaminated composite.
pub fn analyse_histogram(id: DeltaId, h: &Histogram, breaks: Breaks) -> HistogramAnalysis {
    let name = id.name();
    let total: u64 = h.counts.iter().sum();
    if total == 0 || h.counts.is_empty() {
        return HistogramAnalysis {
            shape: "empty",
            suggested_low: None,
            diagnostics: vec![diagnostic(
                Severity::Warning,
                format!("{name}: empty histogram"),
                "No valid pixels were returned. The boundary may fall outside the composite, or every scene may have been filtered out by the cloud ceiling.".into(),
                "SOP Step 6",
            )],
        };
    }
    let flagged_fraction = mass_at_or_above(h, breaks.low) as f64 / total as f64;

    let mut peak = 0;
    for i in 1..h.counts.len() {
        if h.counts[i] > h.counts[peak] {
            peak = i;
        }
    }
    let peak_count = h.counts[peak] as f64;
    let peak_start = h.starts[peak];

    // A gap is a run of near-empty bins right of the peak with mass beyond it.
    let gap_ceiling = peak_count * 0.005;
    let min_gap_bins = 3;
    let (mut gap_start, mut gap_end, mut run): (i64, i64, usize) = (-1, -1, 0);
    for i in peak + 1..h.counts.len() {
        if h.counts[i] as f64 <= gap_ceiling {
            if run == 0 {
                gap_start = i as i64;
            }
            run += 1;
            gap_end = i as i64;
        } else if run >= min_gap_bins {
            break;
        } else {
            run = 0;
            gap_start = -1;
            gap_end = -1;
        }
    }
    let has_gap = run >= min_gap_bins && gap_start > 0;
    let mass_beyond_gap: u64 = if has_gap { h.counts[(gap_end + 1) as usize..].iter().sum() } else { 0 };
    let bimodal = has_gap && mass_beyond_gap as f64 / total as f64 > 0.0005;
    let far_tail_fraction = mass_at_or_above(h, breaks.high) as f64 / total as f64;

    let mut diagnostics = Vec::new();
    let mut suggested_low = None;
    let shape = if bimodal {
        let (a, b) = (h.starts[gap_start as usize], h.starts[gap_end as usize]);
        suggested_low = Some((a + b) / 2.0);
        diagnostics.push(diagnostic(
            Severity::Info,
            format!("{name}: bimodal distribution with a clear gap"),
            format!("A gap separates the noise bulk from a second group of pixels above {a:.2}. This is the signature of real disturbance. Place the Low break inside the gap rather than on the default."),
            "SOP Step 6, distribution diagnostics",
        ));
        "bimodal-gap"
    } else if far_tail_fraction > 0.02 || flagged_fraction > 0.15 {
        diagnostics.push(diagnostic(
            Severity::Warning,
            format!("{name}: unimodal with a long right tail and no gap"),
            "Many pixels sit at or above the Low break with no gap separating them from unchanged ground. SOP Step 6 attributes this to composite contamination by cloud shadow, senescence or view angle. Check the date windows before moving the class breaks.".into(),
            "SOP Step 6 and Appendix A.1",
        ));
        "unimodal-long-tail"
    } else {
        diagnostics.push(diagnostic(
            Severity::Info,
            format!("{name}: unimodal at zero with a narrow tail"),
            "Noise and phenology only. The default breaks hold without adjustment.".into(),
            "SOP Step 6, distribution diagnostics",
        ));
        "unimodal-narrow"
    };

    // Ten bins off zero, 0.1 on the optical indices and 1 dB on the radar drop.
    if peak_start > h.width() * 10.0 {
        diagnostics.push(diagnostic(
            Severity::Warning,
            format!("{name}: distribution is not centred on zero"),
            format!("The tallest bin sits at {peak_start:.2} rather than near zero, which points to a systematic offset between the pre and post composites rather than local change."),
            "SOP Step 6",
        ));
    }
    HistogramAnalysis { shape, suggested_low, diagnostics }
}

fn month_of(date: &str) -> u32 {
    date.get(5..7).and_then(|m| m.parse().ok()).unwrap_or(0)
}

/// The checker's `checkPeriod`, SOP Step 3, Step 8 and Appendix A.1. It is
/// an optical rule; the radar check wants frozen ground instead.
pub fn check_period(label: &str, pre_start: &str, pre_end: &str, post_start: &str, post_end: &str) -> Vec<Diagnostic> {
    let mut out = Vec::new();
    let months = [month_of(pre_start), month_of(pre_end), month_of(post_start), month_of(post_end)];
    if months.iter().any(|&m| m != 0 && !(6..=9).contains(&m)) {
        out.push(diagnostic(
            Severity::Warning,
            format!("{label}: window falls outside the growing season"),
            "Dormant-season composites corrupt dNDMI, because senescence raises SWIR1 reflectance before leaf-fall and produces a uniform false moisture-stress signal. Use July to September for both pre and post.".into(),
            "SOP Step 3 and Appendix A.1",
        ));
    }
    if month_of(pre_start) != month_of(post_start) || month_of(pre_end) != month_of(post_end) {
        out.push(diagnostic(
            Severity::Warning,
            format!("{label}: pre and post windows cover different months"),
            "Phenology drift between mismatched windows is the most common source of false change. Use the same calendar window for pre and post.".into(),
            "SOP Step 8",
        ));
    }
    out
}
