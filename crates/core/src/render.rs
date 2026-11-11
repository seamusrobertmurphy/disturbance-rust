//! Map images. Ported from `src/render/paint.ts` in disturbance-checker-srm
//! 0.14.3: the UTM grid is resampled by nearest pixel onto a longitude and
//! latitude image of at most 2048 pixels a side, then saved as PNG.

use crate::defaults::{CLASS_NODATA, RGB_GAMMA, RGB_MAX, RGB_MIN};
use crate::grid::{TargetGrid, Utm, grid_bbox};

pub struct Warp {
    pub width: u32,
    pub height: u32,
    /// West, south, east, north in degrees.
    pub bounds: [f64; 4],
    /// Grid pixel shown at each image pixel, or -1 off the grid.
    index: Vec<i32>,
}

pub fn build_warp(grid: &TargetGrid, max_dimension: u32) -> Result<Warp, String> {
    let utm = Utm::new(grid.epsg)?;
    let [min_x, min_y, max_x, max_y] = grid_bbox(grid);
    let corners = [
        utm.inverse(min_x, max_y),
        utm.inverse(max_x, max_y),
        utm.inverse(max_x, min_y),
        utm.inverse(min_x, min_y),
    ];
    let bounds = [
        corners.iter().map(|c| c.0).fold(f64::INFINITY, f64::min),
        corners.iter().map(|c| c.1).fold(f64::INFINITY, f64::min),
        corners.iter().map(|c| c.0).fold(f64::NEG_INFINITY, f64::max),
        corners.iter().map(|c| c.1).fold(f64::NEG_INFINITY, f64::max),
    ];
    let scale = (max_dimension as f64 / grid.width.max(grid.height) as f64).min(1.0);
    let width = ((grid.width as f64 * scale).round() as u32).max(1);
    let height = ((grid.height as f64 * scale).round() as u32).max(1);
    let lon_step = (bounds[2] - bounds[0]) / width as f64;
    let lat_step = (bounds[3] - bounds[1]) / height as f64;
    let mut index = vec![-1i32; (width * height) as usize];
    for row in 0..height {
        let lat = bounds[3] - (row as f64 + 0.5) * lat_step;
        for col in 0..width {
            let lon = bounds[0] + (col as f64 + 0.5) * lon_step;
            let (e, n) = utm.forward(lon, lat);
            let x = ((e - grid.origin_x) / grid.resolution).floor();
            let y = ((grid.origin_y - n) / grid.resolution).floor();
            if x >= 0.0 && y >= 0.0 && x < grid.width as f64 && y < grid.height as f64 {
                index[(row * width + col) as usize] = (y as u32 * grid.width + x as u32) as i32;
            }
        }
    }
    Ok(Warp { width, height, bounds, index })
}

/// An image where each pixel's colour comes from its grid pixel, or is
/// transparent where `colour` gives none or the image runs off the grid.
pub fn paint_with(warp: &Warp, mut colour: impl FnMut(usize) -> Option<[u8; 4]>) -> Vec<u8> {
    let mut out = vec![0u8; warp.index.len() * 4];
    for (i, &source) in warp.index.iter().enumerate() {
        if source < 0 {
            continue;
        }
        if let Some(rgba) = colour(source as usize) {
            out[i * 4..i * 4 + 4].copy_from_slice(&rgba);
        }
    }
    out
}

/// Classes 1 to 3 in the delta's colours; no change and no data transparent.
pub fn paint_classified(classes: &[u8], palette: [[u8; 3]; 3], warp: &Warp) -> Vec<u8> {
    let mut out = vec![0u8; warp.index.len() * 4];
    for (i, &source) in warp.index.iter().enumerate() {
        if source < 0 {
            continue;
        }
        let v = classes[source as usize];
        if v == CLASS_NODATA || v == 0 {
            continue;
        }
        let [r, g, b] = palette[(v as usize - 1).min(2)];
        out[i * 4..i * 4 + 4].copy_from_slice(&[r, g, b, 255]);
    }
    out
}

fn stretch(value: f32) -> u8 {
    let t = ((value as f64 - RGB_MIN) / (RGB_MAX - RGB_MIN)).clamp(0.0, 1.0);
    (t.powf(1.0 / RGB_GAMMA) * 255.0).round() as u8
}

/// True colour: reflectance 0.02 to 0.25, gamma 1.2.
pub fn paint_rgb(red: &[f32], green: &[f32], blue: &[f32], warp: &Warp) -> Vec<u8> {
    let mut out = vec![0u8; warp.index.len() * 4];
    for (i, &source) in warp.index.iter().enumerate() {
        if source < 0 {
            continue;
        }
        let s = source as usize;
        let (r, g, b) = (red[s], green[s], blue[s]);
        if r.is_nan() || g.is_nan() || b.is_nan() {
            continue;
        }
        out[i * 4..i * 4 + 4].copy_from_slice(&[stretch(r), stretch(g), stretch(b), 255]);
    }
    out
}

/// RGBA pixels to a PNG file in memory.
pub fn png(rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_compression(png::Compression::Fast);
        let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
        writer.write_image_data(rgba).map_err(|e| e.to_string())?;
    }
    Ok(bytes)
}
