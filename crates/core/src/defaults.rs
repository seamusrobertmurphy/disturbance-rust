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

/// The three spectral changes the SOP classifies.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum DeltaId {
    #[serde(rename = "dNDVI")]
    DNdvi,
    #[serde(rename = "dNDMI")]
    DNdmi,
    #[serde(rename = "dNBR")]
    DNbr,
}

impl DeltaId {
    pub const ALL: [DeltaId; 3] = [DeltaId::DNdvi, DeltaId::DNdmi, DeltaId::DNbr];

    pub fn name(self) -> &'static str {
        match self {
            DeltaId::DNdvi => "dNDVI",
            DeltaId::DNdmi => "dNDMI",
            DeltaId::DNbr => "dNBR",
        }
    }

    pub fn meaning(self) -> &'static str {
        match self {
            DeltaId::DNdvi => "canopy loss",
            DeltaId::DNdmi => "moisture stress",
            DeltaId::DNbr => "burn severity",
        }
    }

    /// SOP Step 6 default breaks; dNBR's follow MTBS and USFS PNW.
    pub fn default_breaks(self) -> Breaks {
        match self {
            DeltaId::DNdvi => Breaks { low: 0.10, moderate: 0.20, high: 0.35 },
            DeltaId::DNdmi => Breaks { low: 0.15, moderate: 0.30, high: 0.45 },
            DeltaId::DNbr => Breaks { low: 0.10, moderate: 0.27, high: 0.44 },
        }
    }

    /// Low, moderate and high colours on the map.
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
