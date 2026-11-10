//! The per-pixel median of the clear looks in one window. Ported from
//! `src/raster/composite.ts` in disturbance-checker-srm 0.14.3.
//!
//! The checker stores every pixel value as a 32-bit float and calculates in
//! 64-bit. This file does the same, so the medians match to the last bit.

use std::collections::HashMap;

use crate::defaults::{ATMOSPHERE_DIVISOR, S2_SCALE_DIVISOR};
use crate::mask::{self, MaskOptions};
use crate::stac::{Band, Observation};

/// Bands the indices need.
pub const INDEX_BANDS: [Band; 5] = [Band::Red, Band::Nir, Band::Nir08, Band::Swir16, Band::Swir22];
/// Bands read only for the true-colour picture and the atmosphere report.
pub const RGB_EXTRA_BANDS: [Band; 2] = [Band::Blue, Band::Green];
pub const ATMOSPHERE_BANDS: [Band; 2] = [Band::Aot, Band::Wvp];

/// Every band of one observation over one block, by band.
pub type SceneBlock = HashMap<Band, Vec<f32>>;

#[derive(Clone, Copy, Debug, Default)]
pub struct Sum {
    pub sum: f64,
    pub count: u64,
}

pub struct CompositeBlock {
    /// Median reflectance of each index band.
    pub bands: HashMap<Band, Vec<f32>>,
    pub atmosphere: HashMap<Band, Sum>,
    pub rgb: [Vec<f32>; 3],
    /// Clear looks per pixel.
    pub counts: Vec<u16>,
    pub water: Vec<u8>,
    pub length: usize,
}

/// The median the checker computes: insertion sort on 32-bit values, the
/// even case averaged.
fn median_of(scratch: &mut [f32], n: usize) -> f32 {
    if n == 0 {
        return f32::NAN;
    }
    if n == 1 {
        return scratch[0];
    }
    for i in 1..n {
        let value = scratch[i];
        let mut j = i as isize - 1;
        while j >= 0 && scratch[j as usize] > value {
            scratch[j as usize + 1] = scratch[j as usize];
            j -= 1;
        }
        scratch[(j + 1) as usize] = value;
    }
    let mid = n >> 1;
    if n % 2 == 1 {
        scratch[mid]
    } else {
        ((scratch[mid - 1] as f64 + scratch[mid] as f64) / 2.0) as f32
    }
}

/// The checker's `buildComposite`, for one window and one block.
pub fn build_composite(
    observations: &[Observation],
    blocks: &[SceneBlock],
    options: MaskOptions,
    length: usize,
    rgb_subset: &[usize],
) -> CompositeBlock {
    let offsets: Vec<f64> = observations.iter().map(|o| o.scenes[0].boa_offset_correction()).collect();
    let empty = vec![0f32; length];
    let scl_of = |b: &SceneBlock| b.get(&Band::Scl).cloned().unwrap_or_else(|| empty.clone());
    let keeps: Vec<Vec<u8>> = blocks.iter().map(|b| mask::keep(&scl_of(b), options)).collect();
    let waters: Vec<Vec<u8>> = blocks.iter().map(|b| mask::water(&scl_of(b))).collect();

    // A look is valid where SCL keeps it and every index band has data.
    let mut counts = vec![0u16; length];
    let mut valid: Vec<Vec<u8>> = Vec::with_capacity(blocks.len());
    for (s, block) in blocks.iter().enumerate() {
        let mut ok = vec![0u8; length];
        let bands: Vec<&Vec<f32>> = INDEX_BANDS.iter().filter_map(|b| block.get(b)).collect();
        let complete_bands = bands.len() == INDEX_BANDS.len();
        for i in 0..length {
            if keeps[s][i] == 0 {
                continue;
            }
            let complete = complete_bands && bands.iter().all(|b| b[i] != 0.0);
            ok[i] = complete as u8;
            counts[i] += complete as u16;
        }
        valid.push(ok);
    }

    let mut scratch = vec![0f32; blocks.len().max(1)];
    let mut median_over = |band: Band, which: &[usize]| -> Vec<f32> {
        let mut out = vec![0f32; length];
        for (i, o) in out.iter_mut().enumerate() {
            let mut n = 0;
            for &s in which {
                if valid[s][i] == 0 {
                    continue;
                }
                let Some(values) = blocks[s].get(&band) else { continue };
                scratch[n] = ((values[i] as f64 - offsets[s]) / S2_SCALE_DIVISOR) as f32;
                n += 1;
            }
            *o = median_of(&mut scratch, n);
        }
        out
    };

    let all: Vec<usize> = (0..blocks.len()).collect();
    let mut bands = HashMap::new();
    for band in INDEX_BANDS {
        bands.insert(band, median_over(band, &all));
    }
    let has_blue = |i: &usize| blocks[*i].contains_key(&Band::Blue);
    let subset: Vec<usize> = rgb_subset.iter().copied().filter(has_blue).collect();
    let rgb_from: Vec<usize> = if subset.is_empty() { all.iter().copied().filter(has_blue).collect() } else { subset };
    let rgb = [
        median_over(Band::Red, &rgb_from),
        median_over(Band::Green, &rgb_from),
        median_over(Band::Blue, &rgb_from),
    ];

    let mut atmosphere = HashMap::new();
    for band in ATMOSPHERE_BANDS {
        let from: Vec<usize> = all.iter().copied().filter(|&s| blocks[s].contains_key(&band)).collect();
        let mut held = Sum::default();
        for i in 0..length {
            for &s in &from {
                if valid[s][i] == 0 {
                    continue;
                }
                let value = blocks[s][&band][i];
                if value == 0.0 {
                    continue;
                }
                held.sum += value as f64 / ATMOSPHERE_DIVISOR;
                held.count += 1;
            }
        }
        atmosphere.insert(band, held);
    }

    CompositeBlock {
        bands,
        atmosphere,
        rgb,
        counts,
        water: mask::combine_water(&waters, &valid, length),
        length,
    }
}
