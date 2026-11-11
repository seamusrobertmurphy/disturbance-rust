//! Every constant of the method, from `src/defaults.ts` in
//! disturbance-checker-srm 0.14.3 and the SOP "Canopy Disturbance Checks for
//! ACR IFM Verification".

use serde::{Deserialize, Serialize};

/// DN to reflectance.
pub const S2_SCALE_DIVISOR: f64 = 10_000.0;
/// AOT and WVP DN to their physical units.
pub const ATMOSPHERE_DIVISOR: f64 = 1_000.0;
/// Scene cloud ceiling in per cent.
pub const DEFAULT_MAX_CLOUD: f64 = 30.0;
/// The SOP's stability floor for the median, in clear looks.
pub const MIN_STABLE_SCENE_COUNT: usize = 4;
/// Observations per window used for the true-colour picture.
pub const RGB_OBSERVATION_COUNT: usize = 3;
/// Histogram of every delta, the SOP's range.
pub const HISTOGRAM_MIN: f64 = -0.5;
pub const HISTOGRAM_MAX: f64 = 0.8;
pub const HISTOGRAM_STEPS: usize = 130;
/// The scene-wide shift: the unchanged peak must hold this share of pixels
/// within this distance of it.
pub const STABLE_WINDOW: f64 = 0.05;
pub const MIN_STABLE_SHARE: f64 = 0.5;
/// Difference in mean aerosol optical thickness that raises a warning.
pub const AOT_DIFFERENCE_WARNING: f64 = 0.1;
/// Class value for a pixel with no delta.
pub const CLASS_NODATA: u8 = 255;

/// Which satellite a run reads.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Sensor {
    /// Sentinel-2 light, the SOP's check, three indices.
    #[default]
    #[serde(rename = "sentinel-2")]
    Sentinel2,
    /// Sentinel-1 radar, one layer, the drop in VH backscatter.
    #[serde(rename = "sentinel-1")]
    Sentinel1,
}

/// The fixed histogram a change is counted on.
#[derive(Clone, Copy, Debug)]
pub struct HistogramSpec {
    pub min: f64,
    pub max: f64,
    pub steps: usize,
}

/// The three spectral changes the SOP classifies, and the radar drop.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub enum DeltaId {
    #[serde(rename = "dNDVI")]
    DNdvi,
    #[serde(rename = "dNDMI")]
    DNdmi,
    #[serde(rename = "dNBR")]
    DNbr,
    #[serde(rename = "dVH")]
    DVh,
}

impl DeltaId {
    pub const ALL: [DeltaId; 4] = [DeltaId::DNdvi, DeltaId::DNdmi, DeltaId::DNbr, DeltaId::DVh];
    pub const OPTICAL: [DeltaId; 3] = [DeltaId::DNdvi, DeltaId::DNdmi, DeltaId::DNbr];

    pub fn name(self) -> &'static str {
        match self {
            DeltaId::DNdvi => "dNDVI",
            DeltaId::DNdmi => "dNDMI",
            DeltaId::DNbr => "dNBR",
            DeltaId::DVh => "dVH",
        }
    }

    pub fn meaning(self) -> &'static str {
        match self {
            DeltaId::DNdvi => "canopy loss",
            DeltaId::DNdmi => "moisture stress",
            DeltaId::DNbr => "burn severity",
            DeltaId::DVh => "radar canopy loss",
        }
    }

    pub fn sensor(self) -> Sensor {
        match self {
            DeltaId::DVh => Sensor::Sentinel1,
            _ => Sensor::Sentinel2,
        }
    }

    /// The unit the breaks are read in.
    pub fn unit(self) -> &'static str {
        match self {
            DeltaId::DVh => " dB",
            _ => "",
        }
    }

    /// Which window is taken from which.
    pub fn direction(self) -> &'static str {
        match self {
            DeltaId::DNbr => "post minus pre",
            _ => "pre minus post",
        }
    }

    /// SOP Step 6 default breaks; dNBR's follow MTBS and USFS PNW, and dVH's
    /// the checker's Cochrane, Ontario test.
    pub fn default_breaks(self) -> Breaks {
        match self {
            DeltaId::DNdvi => Breaks { low: 0.10, moderate: 0.20, high: 0.35 },
            DeltaId::DNdmi => Breaks { low: 0.15, moderate: 0.30, high: 0.45 },
            DeltaId::DNbr => Breaks { low: 0.10, moderate: 0.27, high: 0.44 },
            DeltaId::DVh => Breaks { low: 2.0, moderate: 2.5, high: 3.5 },
        }
    }

    /// Where the default breaks come from, for the run record.
    pub fn source(self) -> &'static str {
        match self {
            DeltaId::DNdvi | DeltaId::DNdmi => "SOP Step 6 default breaks",
            DeltaId::DNbr => "SOP Step 6 default breaks (MTBS / USFS PNW)",
            DeltaId::DVh => "Cochrane, Ontario calibration against 2024 to 2025 annual report clearcuts",
        }
    }

    /// The optical indices share the SOP's range; the radar drop runs from
    /// -5 to 10 dB in tenths.
    pub fn histogram_spec(self) -> HistogramSpec {
        match self {
            DeltaId::DVh => HistogramSpec { min: -5.0, max: 10.0, steps: 150 },
            _ => HistogramSpec { min: HISTOGRAM_MIN, max: HISTOGRAM_MAX, steps: HISTOGRAM_STEPS },
        }
    }

    /// Low, moderate and high colours on the map. The notebook draws the
    /// radar classes with the dNDVI ramp.
    pub fn palette(self) -> [[u8; 3]; 3] {
        match self {
            DeltaId::DNdmi => [[0xFE, 0xB2, 0x4C], [0xFD, 0x8D, 0x3C], [0xB1, 0x00, 0x26]],
            _ => [[0xFF, 0xED, 0xA0], [0xFC, 0x4E, 0x2A], [0x80, 0x00, 0x26]],
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Breaks {
    pub low: f64,
    pub moderate: f64,
    pub high: f64,
}

/// True-colour stretch: reflectance 0.02 to 0.25, gamma 1.2.
pub const RGB_MIN: f64 = 0.02;
pub const RGB_MAX: f64 = 0.25;
pub const RGB_GAMMA: f64 = 1.2;
