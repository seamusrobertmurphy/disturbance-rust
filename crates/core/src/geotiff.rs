//! GeoTIFF files of a run, on the run's own UTM grid, for desktop GIS.
//!
//! The browser draws PNGs warped to the web map. ArcGIS Pro and QGIS want
//! the pixels where they were computed, with the grid's coordinate system
//! attached, so each layer is also written here as a plain GeoTIFF:
//! deflate strips, one tie point, the pixel size and the EPSG code.
//!
//! Three kinds are written. A change is one float band, NaN where there is
//! none. Classes are one byte band with the palette inside the file, so
//! Pro and QGIS colour them without a style. True colour is three byte
//! bands stretched as the map draws them.
//!
//! Rust note. A TIFF is a header, then the pixel data, then a directory of
//! tags saying where everything is. Each tag is 12 bytes: its number, its
//! type, how many values, and either the values or where they sit.

use crate::grid::TargetGrid;

/// Rows per compressed strip.
const ROWS_PER_STRIP: u32 = 16;

const SHORT: u16 = 3;
const LONG: u16 = 4;
const ASCII: u16 = 2;
const DOUBLE: u16 = 12;

enum Values {
    Short(Vec<u16>),
    Long(Vec<u32>),
    Ascii(String),
    Double(Vec<f64>),
}

struct Tag {
    id: u16,
    values: Values,
}

impl Tag {
    fn short(id: u16, v: u16) -> Tag {
        Tag { id, values: Values::Short(vec![v]) }
    }
    fn long(id: u16, v: u32) -> Tag {
        Tag { id, values: Values::Long(vec![v]) }
    }
    fn kind_count_bytes(&self) -> (u16, u32, Vec<u8>) {
        match &self.values {
            Values::Short(v) => (SHORT, v.len() as u32, v.iter().flat_map(|x| x.to_le_bytes()).collect()),
            Values::Long(v) => (LONG, v.len() as u32, v.iter().flat_map(|x| x.to_le_bytes()).collect()),
            Values::Ascii(s) => {
                let mut b = s.as_bytes().to_vec();
                b.push(0);
                (ASCII, b.len() as u32, b)
            }
            Values::Double(v) => (DOUBLE, v.len() as u32, v.iter().flat_map(|x| x.to_le_bytes()).collect()),
        }
    }
}

/// How the samples of one pixel are stored.
#[derive(Clone, Copy)]
enum Sample {
    Float32,
    Byte,
}

/// One GeoTIFF in memory. `pixels` holds the samples of each row, pixel
/// interleaved, already in their stored form.
fn write(grid: &TargetGrid, samples_per_pixel: u16, sample: Sample, photometric: u16, pixels: &[u8], nodata: Option<&str>, palette: Option<Vec<u16>>) -> Vec<u8> {
    let bytes_per_sample = match sample {
        Sample::Float32 => 4,
        Sample::Byte => 1,
    };
    let row_bytes = grid.width as usize * samples_per_pixel as usize * bytes_per_sample;

    // Header, then the strips.
    let mut out: Vec<u8> = vec![b'I', b'I', 42, 0, 0, 0, 0, 0];
    let mut offsets = Vec::new();
    let mut counts = Vec::new();
    for start in (0..grid.height).step_by(ROWS_PER_STRIP as usize) {
        let rows = ROWS_PER_STRIP.min(grid.height - start) as usize;
        let from = start as usize * row_bytes;
        let strip = miniz_oxide::deflate::compress_to_vec_zlib(&pixels[from..from + rows * row_bytes], 6);
        offsets.push(out.len() as u32);
        counts.push(strip.len() as u32);
        out.extend_from_slice(&strip);
        if out.len() % 2 == 1 {
            out.push(0);
        }
    }

    let mut tags = vec![
        Tag::long(256, grid.width),
        Tag::long(257, grid.height),
        Tag { id: 258, values: Values::Short(vec![bytes_per_sample as u16 * 8; samples_per_pixel as usize]) },
        Tag::short(259, 8),
        Tag::short(262, photometric),
        Tag { id: 273, values: Values::Long(offsets) },
        Tag::short(277, samples_per_pixel),
        Tag::long(278, ROWS_PER_STRIP),
        Tag { id: 279, values: Values::Long(counts) },
        Tag::short(284, 1),
        Tag {
            id: 339,
            values: Values::Short(vec![
                match sample {
                    Sample::Float32 => 3,
                    Sample::Byte => 1,
                };
                samples_per_pixel as usize
            ]),
        },
        Tag { id: 33550, values: Values::Double(vec![grid.resolution, grid.resolution, 0.0]) },
        Tag { id: 33922, values: Values::Double(vec![0.0, 0.0, 0.0, grid.origin_x, grid.origin_y, 0.0]) },
        // Projected, pixel is area, the EPSG code, metres.
        Tag { id: 34735, values: Values::Short(vec![1, 1, 0, 4, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, grid.epsg as u16, 3076, 0, 1, 9001]) },
    ];
    if let Some(p) = palette {
        tags.push(Tag { id: 320, values: Values::Short(p) });
    }
    if let Some(n) = nodata {
        tags.push(Tag { id: 42113, values: Values::Ascii(n.into()) });
    }
    tags.sort_by_key(|t| t.id);

    // The directory, with any value longer than four bytes after it.
    let directory_at = out.len() as u32;
    out[4..8].copy_from_slice(&directory_at.to_le_bytes());
    let directory_len = 2 + tags.len() * 12 + 4;
    let mut extra: Vec<u8> = Vec::new();
    let mut entries: Vec<u8> = Vec::with_capacity(directory_len);
    entries.extend_from_slice(&(tags.len() as u16).to_le_bytes());
    for tag in &tags {
        let (kind, count, mut bytes) = tag.kind_count_bytes();
        entries.extend_from_slice(&tag.id.to_le_bytes());
        entries.extend_from_slice(&kind.to_le_bytes());
        entries.extend_from_slice(&count.to_le_bytes());
        if bytes.len() <= 4 {
            bytes.resize(4, 0);
            entries.extend_from_slice(&bytes);
        } else {
            let at = directory_at as usize + directory_len + extra.len();
            entries.extend_from_slice(&(at as u32).to_le_bytes());
            extra.extend_from_slice(&bytes);
            if extra.len() % 2 == 1 {
                extra.push(0);
            }
        }
    }
    entries.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&entries);
    out.extend_from_slice(&extra);
    out
}

/// One change, or one radar band, as a float GeoTIFF. NaN is no data.
pub fn float_band(grid: &TargetGrid, values: &[f32]) -> Vec<u8> {
    let pixels: Vec<u8> = values.iter().flat_map(|v| v.to_le_bytes()).collect();
    write(grid, 1, Sample::Float32, 1, &pixels, Some("nan"), None)
}

/// Classes 1 low, 2 moderate, 3 high, with the palette inside the file.
/// Unchanged pixels and pixels outside the boundary are both 0, no data,
/// so only the three classes show, as the Earth Engine notebook drew them.
pub fn classes(grid: &TargetGrid, classes: &[u8], palette: [[u8; 3]; 3]) -> Vec<u8> {
    let pixels: Vec<u8> = classes.iter().map(|&c| if (1..=3).contains(&c) { c } else { 0 }).collect();
    // A TIFF colour map is every red, then every green, then every blue,
    // each scaled to 16 bits.
    let mut map = vec![0u16; 3 * 256];
    for (k, colour) in palette.iter().enumerate() {
        for channel in 0..3 {
            map[channel * 256 + k + 1] = colour[channel] as u16 * 257;
        }
    }
    write(grid, 1, Sample::Byte, 3, &pixels, Some("0"), Some(map))
}

/// True colour, stretched as the map layer is. 0 is no data.
pub fn rgb(grid: &TargetGrid, red: &[f32], green: &[f32], blue: &[f32]) -> Vec<u8> {
    let mut pixels = vec![0u8; red.len() * 3];
    for i in 0..red.len() {
        let (r, g, b) = (red[i], green[i], blue[i]);
        if r.is_nan() || g.is_nan() || b.is_nan() {
            continue;
        }
        pixels[i * 3] = crate::render::stretch(r).max(1);
        pixels[i * 3 + 1] = crate::render::stretch(g).max(1);
        pixels[i * 3 + 2] = crate::render::stretch(b).max(1);
    }
    write(grid, 3, Sample::Byte, 2, &pixels, Some("0"), None)
}

/// Every GeoTIFF of one run, named for the file each should go in: per
/// change its classes and its values, then the before and after pictures.
pub fn run_files(result: &crate::run::RunResult, analysis: &crate::run::Analysis) -> Vec<(String, Vec<u8>)> {
    let grid = &analysis.target;
    let mut files = Vec::new();
    for (id, values) in &analysis.deltas {
        let Some(delta) = result.deltas.iter().find(|d| d.id == *id) else { continue };
        let c = crate::deltas::classify_delta(values, delta.breaks_used);
        files.push((format!("{}-classes.tif", id.name()), classes(grid, &c, id.palette())));
        files.push((format!("{}-change.tif", id.name()), float_band(grid, values)));
    }
    for backdrop in &result.backdrops {
        let tif = match backdrop.bands.as_slice() {
            [r, g, b] => rgb(grid, r, g, b),
            [one] => float_band(grid, one),
            _ => continue,
        };
        files.push((format!("{}.tif", backdrop.key), tif));
    }
    files
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grid() -> TargetGrid {
        TargetGrid { epsg: 32610, origin_x: 500000.0, origin_y: 4870000.0, resolution: 20.0, width: 5, height: 40 }
    }

    #[test]
    fn header_and_directory_are_where_they_say() {
        let values: Vec<f32> = (0..200).map(|i| i as f32).collect();
        let tif = float_band(&grid(), &values);
        assert_eq!(&tif[0..4], &[b'I', b'I', 42, 0]);
        let at = u32::from_le_bytes(tif[4..8].try_into().unwrap()) as usize;
        let n = u16::from_le_bytes(tif[at..at + 2].try_into().unwrap());
        assert!(n >= 14);
        // Strips: 40 rows at 16 a strip is three.
        let ids: Vec<u16> = (0..n as usize).map(|k| u16::from_le_bytes(tif[at + 2 + k * 12..at + 4 + k * 12].try_into().unwrap())).collect();
        let mut sorted = ids.clone();
        sorted.sort();
        assert_eq!(ids, sorted);
    }
}
