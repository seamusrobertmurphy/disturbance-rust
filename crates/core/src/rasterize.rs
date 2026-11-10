//! The project boundary as pixels: 1 inside, 0 outside, by the even-odd rule
//! at each pixel's centre. Ported from `src/raster/rasterize.ts` in
//! disturbance-checker-srm 0.14.3.

use serde_json::Value;

use crate::grid::{GridBlock, TargetGrid, Utm};

type Ring = Vec<[f64; 2]>;

fn point(v: &Value) -> Option<[f64; 2]> {
    let a = v.as_array()?;
    let (x, y) = (a.first()?.as_f64()?, a.get(1)?.as_f64()?);
    (x.is_finite() && y.is_finite()).then_some([x, y])
}

fn ring(v: &Value) -> Ring {
    v.as_array().map(|pts| pts.iter().filter_map(point).collect()).unwrap_or_default()
}

/// Every polygon ring in a GeoJSON object, holes included.
pub fn collect_rings(geometry: &Value, rings: &mut Vec<Ring>) {
    match geometry.get("type").and_then(Value::as_str) {
        Some("FeatureCollection") => {
            for f in geometry.get("features").and_then(Value::as_array).into_iter().flatten() {
                collect_rings(f, rings);
            }
        }
        Some("Feature") => {
            if let Some(g) = geometry.get("geometry") {
                collect_rings(g, rings);
            }
        }
        Some("GeometryCollection") => {
            for g in geometry.get("geometries").and_then(Value::as_array).into_iter().flatten() {
                collect_rings(g, rings);
            }
        }
        Some("Polygon") => {
            for r in geometry.get("coordinates").and_then(Value::as_array).into_iter().flatten() {
                rings.push(ring(r));
            }
        }
        Some("MultiPolygon") => {
            for polygon in geometry.get("coordinates").and_then(Value::as_array).into_iter().flatten() {
                for r in polygon.as_array().into_iter().flatten() {
                    rings.push(ring(r));
                }
            }
        }
        _ => {}
    }
}

/// West, south, east, north of every ring, in degrees.
pub fn bounds_of(geometry: &Value) -> Option<[f64; 4]> {
    let mut rings = Vec::new();
    collect_rings(geometry, &mut rings);
    let mut b = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
    for p in rings.iter().flatten() {
        b[0] = b[0].min(p[0]);
        b[1] = b[1].min(p[1]);
        b[2] = b[2].max(p[0]);
        b[3] = b[3].max(p[1]);
    }
    b[0].is_finite().then_some(b)
}

/// The boundary burned onto the grid, or `None` if it holds no polygon.
pub fn rasterize_aoi(geometry: &Value, grid: &TargetGrid) -> Result<Option<Vec<u8>>, String> {
    let mut rings = Vec::new();
    collect_rings(geometry, &mut rings);
    if rings.is_empty() {
        return Ok(None);
    }
    let utm = Utm::new(grid.epsg)?;
    // Edges with y0 below y1; horizontal edges cross no scanline.
    let mut edges: Vec<[f64; 4]> = Vec::new();
    for r in &rings {
        let projected: Vec<(f64, f64)> = r.iter().map(|p| utm.forward(p[0], p[1])).collect();
        for i in 0..projected.len() {
            let (ax, ay) = projected[i];
            let (bx, by) = projected[(i + 1) % projected.len()];
            if ay == by {
                continue;
            }
            edges.push(if ay < by { [ax, ay, bx, by] } else { [bx, by, ax, ay] });
        }
    }
    if edges.is_empty() {
        return Ok(None);
    }
    let (w, h) = (grid.width as usize, grid.height as usize);
    let mut mask = vec![0u8; w * h];
    let mut crossings: Vec<f64> = Vec::new();
    for row in 0..h {
        let y = grid.origin_y - (row as f64 + 0.5) * grid.resolution;
        crossings.clear();
        for e in &edges {
            if y < e[1] || y >= e[3] {
                continue;
            }
            let t = (y - e[1]) / (e[3] - e[1]);
            crossings.push(e[0] + t * (e[2] - e[0]));
        }
        if crossings.len() < 2 {
            continue;
        }
        crossings.sort_by(|a, b| a.total_cmp(b));
        let mut i = 0;
        while i + 1 < crossings.len() {
            let from = ((crossings[i] - grid.origin_x) / grid.resolution - 0.5).ceil().max(0.0) as i64;
            let to = (((crossings[i + 1] - grid.origin_x) / grid.resolution - 0.5).floor() as i64).min(w as i64 - 1);
            for column in from..=to {
                mask[row * w + column as usize] = 1;
            }
            i += 2;
        }
    }
    Ok(Some(mask))
}

/// The part of a grid-wide mask that falls in one block.
pub fn mask_for_block(mask: &[u8], block: &GridBlock, grid: &TargetGrid) -> Vec<u8> {
    let mut out = Vec::with_capacity((block.width * block.height) as usize);
    for row in 0..block.height {
        let from = ((block.y + row) * grid.width + block.x) as usize;
        out.extend_from_slice(&mask[from..from + block.width as usize]);
    }
    out
}
