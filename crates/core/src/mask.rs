//! Cloud masking with SCL, Sen2Cor's scene classification shipped with each
//! scene. Ported from `src/raster/mask.ts` in disturbance-checker-srm 0.14.3.

use serde::{Deserialize, Serialize};

/// SCL class numbers.
pub mod scl {
    pub const NO_DATA: u8 = 0;
    pub const SATURATED: u8 = 1;
    pub const CAST_SHADOW: u8 = 2;
    pub const CLOUD_SHADOW: u8 = 3;
    pub const WATER: u8 = 6;
    pub const CLOUD_MEDIUM: u8 = 8;
    pub const CLOUD_HIGH: u8 = 9;
    pub const THIN_CIRRUS: u8 = 10;
    pub const SNOW: u8 = 11;
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct MaskOptions {
    pub reject_cast_shadow: bool,
    pub reject_snow: bool,
}

impl Default for MaskOptions {
    fn default() -> Self {
        MaskOptions { reject_cast_shadow: true, reject_snow: true }
    }
}

/// A table of the 256 possible SCL values, true where the pixel is rejected.
fn rejected(options: MaskOptions) -> [bool; 256] {
    let mut out = [false; 256];
    for class in [scl::NO_DATA, scl::SATURATED, scl::CLOUD_SHADOW, scl::CLOUD_MEDIUM, scl::CLOUD_HIGH, scl::THIN_CIRRUS] {
        out[class as usize] = true;
    }
    if options.reject_cast_shadow {
        out[scl::CAST_SHADOW as usize] = true;
    }
    if options.reject_snow {
        out[scl::SNOW as usize] = true;
    }
    out
}

/// 1 where the pixel is clear, 0 where SCL rejects it.
pub fn keep(scl_values: &[f32], options: MaskOptions) -> Vec<u8> {
    let table = rejected(options);
    scl_values
        .iter()
        .map(|&v| {
            // A value outside 0 to 255 cannot be an SCL class; the checker's
            // Set lookup keeps it, and so does this.
            let class = v as i64;
            if (0..256).contains(&class) && v == class as f32 && table[class as usize] { 0 } else { 1 }
        })
        .collect()
}

/// 1 where SCL calls the pixel water.
pub fn water(scl_values: &[f32]) -> Vec<u8> {
    scl_values.iter().map(|&v| (v == scl::WATER as f32) as u8).collect()
}

/// Water by majority vote over the clear looks, the checker's `combineWater`.
pub fn combine_water(waters: &[Vec<u8>], valid: &[Vec<u8>], length: usize) -> Vec<u8> {
    let mut wet = vec![0i32; length];
    let mut seen = vec![0i32; length];
    for (water, ok) in waters.iter().zip(valid) {
        for i in 0..length {
            if ok[i] == 0 {
                continue;
            }
            seen[i] += 1;
            wet[i] += water[i] as i32;
        }
    }
    (0..length).map(|i| (seen[i] > 0 && wet[i] * 2 > seen[i]) as u8).collect()
}
