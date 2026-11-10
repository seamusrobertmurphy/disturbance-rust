//! Indices, deltas, the histogram, the scene-wide shift and the classes.
//! Ported from `src/analysis/deltas.ts` in disturbance-checker-srm 0.14.3.

use serde::Serialize;

use crate::composite::CompositeBlock;
use crate::defaults::{Breaks, CLASS_NODATA, DeltaId, HISTOGRAM_MAX, HISTOGRAM_MIN, HISTOGRAM_STEPS, MIN_STABLE_SHARE, STABLE_WINDOW};
use crate::stac::Band;

fn normalized_difference(a: &[f32], b: &[f32]) -> Vec<f32> {
    a.iter()
        .zip(b)
        .map(|(&a, &b)| {
            let sum = a as f64 + b as f64;
            if sum == 0.0 { f32::NAN } else { ((a as f64 - b as f64) / sum) as f32 }
        })
        .collect()
}

/// NDVI from B8 and B4, NDMI from B8 and B11, NBR from B8A and B12.
pub struct Indices {
    pub ndvi: Vec<f32>,
    pub ndmi: Vec<f32>,
    pub nbr: Vec<f32>,
}

pub fn indices(c: &CompositeBlock) -> Indices {
    let b = |band| &c.bands[&band];
    Indices {
        ndvi: normalized_difference(b(Band::Nir), b(Band::Red)),
        ndmi: normalized_difference(b(Band::Nir), b(Band::Swir16)),
        nbr: normalized_difference(b(Band::Nir08), b(Band::Swir22)),
    }
}

/// dNDVI and dNDMI are pre minus post, dNBR is post minus pre, so a positive
/// value is a loss on all three. A pixel that was water in either window has
/// no delta.
pub fn compute_deltas(pre: &CompositeBlock, post: &CompositeBlock) -> [Vec<f32>; 3] {
    let (a, b) = (indices(pre), indices(post));
    let n = pre.length;
    let mut out = [vec![0f32; n], vec![0f32; n], vec![0f32; n]];
    for i in 0..n {
        if pre.water[i] == 1 || post.water[i] == 1 {
            out[0][i] = f32::NAN;
            out[1][i] = f32::NAN;
            out[2][i] = f32::NAN;
            continue;
        }
        out[0][i] = (a.ndvi[i] as f64 - b.ndvi[i] as f64) as f32;
        out[1][i] = (a.ndmi[i] as f64 - b.ndmi[i] as f64) as f32;
        out[2][i] = (b.nbr[i] as f64 - a.nbr[i] as f64) as f32;
    }
    out
}

/// 0 below low, then 1, 2 and 3 for low, moderate and high.
pub fn classify_delta(delta: &[f32], breaks: Breaks) -> Vec<u8> {
    delta
        .iter()
        .map(|&v| {
            if v.is_nan() {
                return CLASS_NODATA;
            }
            let v = v as f64;
            if v >= breaks.high {
                3
            } else if v >= breaks.moderate {
                2
            } else if v >= breaks.low {
                1
            } else {
                0
            }
        })
        .collect()
}

#[derive(Clone, Debug, Serialize)]
pub struct Histogram {
    pub starts: Vec<f64>,
    pub counts: Vec<u64>,
}

impl Histogram {
    /// 130 bins from -0.5 to 0.8, with bin starts computed as the checker does.
    pub fn new() -> Histogram {
        let width = (HISTOGRAM_MAX - HISTOGRAM_MIN) / HISTOGRAM_STEPS as f64;
        Histogram {
            starts: (0..HISTOGRAM_STEPS).map(|i| HISTOGRAM_MIN + i as f64 * width).collect(),
            counts: vec![0; HISTOGRAM_STEPS],
        }
    }

    /// The bin width as the checker recovers it, from the first two starts.
    fn width(&self) -> f64 {
        if self.starts.len() > 1 { self.starts[1] - self.starts[0] } else { 0.01 }
    }

    pub fn accumulate(&mut self, delta: &[f32]) {
        let width = self.width();
        let min = self.starts.first().copied().unwrap_or(0.0);
        let max = min + width * self.starts.len() as f64;
        for &v in delta {
            if v.is_nan() {
                continue;
            }
            let v = v as f64;
            if v < min || v >= max {
                continue;
            }
            let index = ((v - min) / width).floor();
            if index >= 0.0 && (index as usize) < self.counts.len() {
                self.counts[index as usize] += 1;
            }
        }
    }
}

impl Default for Histogram {
    fn default() -> Self {
        Histogram::new()
    }
}

/// The scene-wide shift measured on one delta's histogram.
#[derive(Clone, Debug, Serialize)]
pub struct Normalisation {
    pub offset: f64,
    pub stable_share: f64,
    pub applicable: bool,
    pub refusal: Option<String>,
}

/// The checker's `normalisationOffset`: the peak of unchanged ground, found
/// by a parabola through the tallest bin and its neighbours, used only when
/// at least half the pixels sit within 0.05 of it and it moved by at least
/// one bin.
pub fn normalisation_offset(h: &Histogram) -> Normalisation {
    let width = h.width();
    let total: u64 = h.counts.iter().sum();
    if total == 0 {
        return Normalisation {
            offset: 0.0,
            stable_share: 0.0,
            applicable: false,
            refusal: Some("No pixel carried a valid delta, so there was no unchanged ground to measure a shift against.".into()),
        };
    }
    let mut peak = 0;
    for i in 1..h.counts.len() {
        if h.counts[i] > h.counts[peak] {
            peak = i;
        }
    }
    let centre = h.starts[peak] + width / 2.0;
    let mut offset = centre;
    if peak > 0 && peak < h.counts.len() - 1 {
        let left = h.counts[peak - 1] as f64;
        let mid = h.counts[peak] as f64;
        let right = h.counts[peak + 1] as f64;
        let denominator = left - 2.0 * mid + right;
        if denominator != 0.0 {
            let shift = (0.5 * (left - right)) / denominator;
            if shift.abs() <= 0.5 {
                offset = centre + shift * width;
            }
        }
    }
    let mut stable = 0u64;
    for (i, &count) in h.counts.iter().enumerate() {
        let bin_centre = h.starts[i] + width / 2.0;
        if (bin_centre - offset).abs() <= STABLE_WINDOW {
            stable += count;
        }
    }
    let stable_share = stable as f64 / total as f64;
    if stable_share < MIN_STABLE_SHARE {
        return Normalisation {
            offset,
            stable_share,
            applicable: false,
            refusal: Some(format!(
                "Only {} per cent of the area sits in the unchanged peak, below the {} per cent this correction needs. On ground where most of the area changed, the peak is built by the disturbance itself and removing it would remove the finding.",
                (stable_share * 100.0).round(),
                (MIN_STABLE_SHARE * 100.0).round()
            )),
        };
    }
    if offset.abs() < width {
        return Normalisation {
            offset,
            stable_share,
            applicable: false,
            refusal: Some(format!(
                "The unchanged ground moved by {offset:.3}, less than the {width:.2} histogram bin the offset is measured on. That is not a shift worth removing."
            )),
        };
    }
    Normalisation { offset, stable_share, applicable: true, refusal: None }
}

pub fn shift_breaks(b: Breaks, offset: f64) -> Breaks {
    Breaks { low: b.low + offset, moderate: b.moderate + offset, high: b.high + offset }
}

/// Pixels in each class 1 to 3. Kept for checking the port against the
/// checker; never reported as an area.
pub fn class_counts(classes: &[u8]) -> [u64; 3] {
    let mut c = [0u64; 3];
    for &v in classes {
        if (1..=3).contains(&v) {
            c[v as usize - 1] += 1;
        }
    }
    c
}

pub fn delta_index(id: DeltaId) -> usize {
    match id {
        DeltaId::DNdvi => 0,
        DeltaId::DNdmi => 1,
        DeltaId::DNbr => 2,
    }
}
