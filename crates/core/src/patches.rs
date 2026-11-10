//! Flagged patches for the results table.
//!
//! A patch is a group of touching pixels, diagonals included, classed
//! moderate or high on one delta. Each is reported by its delta, its highest
//! class, its centre and its strongest value. No patch area is reported,
//! because the change has not been checked on the ground, so the spectral
//! change is not known to be a loss of canopy (Seamus's rule of 6 November
//! 2026). Patches are listed highest class first and, within a class, larger
//! first, so the table opens on the patches most worth a look.

use serde::Serialize;

use crate::defaults::{CLASS_NODATA, DeltaId};
use crate::grid::{TargetGrid, Utm};

#[derive(Clone, Debug, Serialize)]
pub struct Patch {
    pub delta: DeltaId,
    /// 2 for moderate, 3 for high.
    pub class: u8,
    /// Centre of the patch's pixels, in degrees.
    pub lon: f64,
    pub lat: f64,
    /// The largest delta value in the patch.
    pub peak: f64,
    /// Bounds in degrees, west, south, east, north, for zooming the map.
    pub bounds: [f64; 4],
}

/// Up to `limit` patches of one delta, and how many there were in all.
pub fn find_patches(id: DeltaId, classes: &[u8], deltas: &[f32], grid: &TargetGrid, limit: usize) -> Result<(Vec<Patch>, usize), String> {
    let (w, h) = (grid.width as i64, grid.height as i64);
    let flagged = |i: usize| classes[i] != CLASS_NODATA && classes[i] >= 2;
    let mut seen = vec![false; classes.len()];
    let mut found = Vec::new();
    let mut stack = Vec::new();
    for start in 0..classes.len() {
        if seen[start] || !flagged(start) {
            continue;
        }
        seen[start] = true;
        stack.push(start);
        let (mut n, mut sx, mut sy) = (0u64, 0f64, 0f64);
        let (mut x0, mut y0, mut x1, mut y1) = (i64::MAX, i64::MAX, i64::MIN, i64::MIN);
        let (mut class, mut peak) = (0u8, f64::NEG_INFINITY);
        while let Some(i) = stack.pop() {
            let (x, y) = (i as i64 % w, i as i64 / w);
            n += 1;
            sx += x as f64;
            sy += y as f64;
            x0 = x0.min(x);
            y0 = y0.min(y);
            x1 = x1.max(x);
            y1 = y1.max(y);
            class = class.max(classes[i]);
            peak = peak.max(deltas[i] as f64);
            for dy in -1..=1 {
                for dx in -1..=1 {
                    let (nx, ny) = (x + dx, y + dy);
                    if nx < 0 || ny < 0 || nx >= w || ny >= h {
                        continue;
                    }
                    let j = (ny * w + nx) as usize;
                    if !seen[j] && flagged(j) {
                        seen[j] = true;
                        stack.push(j);
                    }
                }
            }
        }
        found.push((class, n, sx / n as f64, sy / n as f64, [x0, y0, x1, y1], peak));
    }
    let total = found.len();
    found.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)));
    found.truncate(limit);

    let utm = Utm::new(grid.epsg)?;
    let to_lon_lat = |x: f64, y: f64| utm.inverse(grid.origin_x + x * grid.resolution, grid.origin_y - y * grid.resolution);
    let patches = found
        .into_iter()
        .map(|(class, _pixels, cx, cy, b, peak)| {
            let (lon, lat) = to_lon_lat(cx + 0.5, cy + 0.5);
            let (west, north) = to_lon_lat(b[0] as f64, b[1] as f64);
            let (east, south) = to_lon_lat(b[2] as f64 + 1.0, b[3] as f64 + 1.0);
            Patch { delta: id, class, lon, lat, peak, bounds: [west, south, east, north] }
        })
        .collect();
    Ok((patches, total))
}
