//! Cloud-optimised GeoTIFFs over HTTP: headers, tiles, and the pixels of one
//! block of the working grid.
//!
//! A cloud-optimised GeoTIFF (COG) is one image file cut into square tiles,
//! with smaller copies of itself, called overviews, stored in the same file.
//! Its header lists every tile's position and size in bytes, so a reader can
//! fetch only the tiles a project touches.
//!
//! The checker's equivalent is `src/raster/cog.ts`, which hands the work to
//! geotiff.js 3.0.5. This file repeats geotiff.js's choices exactly, so the
//! pixels match: the level it reads (`level_geotiff_js`), the window it cuts
//! (`window`) and its nearest-pixel resampling (`sample_block`). It differs in
//! one way only. geotiff.js downloads a tile again for every 512 pixel block
//! that touches it; here each tile is downloaded once per run.
//!
//! The reader is written here rather than taken from a crate, because the
//! GeoTIFF crates tried on 10 November 2026 depended on C code that does not
//! compile for the browser.
//!
//! Rust notes for this file.
//! `Vec<u16>` is a growable array of 16-bit whole numbers, like an R integer
//! vector of one type. `Option<T>` is a value that may be absent, which Rust
//! uses in place of NULL or None, and the compiler insists that the absent case
//! is handled.

use std::collections::{BTreeSet, HashMap};
use std::sync::atomic::{AtomicU64, Ordering};

/// Bytes and requests sent over the network during a run.
#[derive(Debug, Default)]
pub struct Traffic {
    pub bytes: AtomicU64,
    pub requests: AtomicU64,
}

impl Traffic {
    pub fn add(&self, bytes: u64) {
        self.bytes.fetch_add(bytes, Ordering::Relaxed);
        self.requests.fetch_add(1, Ordering::Relaxed);
    }
    pub fn bytes(&self) -> u64 {
        self.bytes.load(Ordering::Relaxed)
    }
    pub fn requests(&self) -> u64 {
        self.requests.load(Ordering::Relaxed)
    }
}

/// One resolution level of a COG: the full image or one overview.
#[derive(Clone, Debug)]
pub struct Level {
    pub width: u32,
    pub height: u32,
    pub tile_width: u32,
    pub tile_height: u32,
    /// Pixel size in metres.
    pub resolution: f64,
    pub bits_per_sample: u16,
    pub compression: u16,
    pub predictor: u16,
    pub tile_offsets: Vec<u64>,
    pub tile_byte_counts: Vec<u64>,
}

impl Level {
    pub fn tiles_across(&self) -> u32 {
        self.width.div_ceil(self.tile_width)
    }
}

/// The parts of a COG header this project uses.
#[derive(Clone, Debug)]
pub struct Cog {
    pub url: String,
    pub little_endian: bool,
    /// Upper left corner of the image in metres.
    pub origin_x: f64,
    pub origin_y: f64,
    /// Index 0 is the full image; the rest are overviews.
    pub levels: Vec<Level>,
}

// ---------------------------------------------------------------- headers

enum ParseError {
    /// The header runs past the bytes fetched so far.
    NeedMore,
    Bad(String),
}

struct Bytes<'a> {
    data: &'a [u8],
    little: bool,
}

impl Bytes<'_> {
    fn slice(&self, at: u64, len: u64) -> Result<&[u8], ParseError> {
        let (at, len) = (at as usize, len as usize);
        self.data.get(at..at + len).ok_or(ParseError::NeedMore)
    }
    fn uint(&self, at: u64, size: u64) -> Result<u64, ParseError> {
        let s = self.slice(at, size)?;
        let mut v = 0u64;
        for i in 0..size as usize {
            let b = if self.little { s[size as usize - 1 - i] } else { s[i] };
            v = (v << 8) | b as u64;
        }
        Ok(v)
    }
}

/// Size in bytes of one value of a TIFF field type.
fn type_size(field_type: u16) -> Option<u64> {
    match field_type {
        1 | 2 | 6 | 7 => Some(1),
        3 | 8 => Some(2),
        4 | 9 | 11 | 13 => Some(4),
        5 | 10 | 12 | 16 | 17 | 18 => Some(8),
        _ => None,
    }
}

/// One header entry: the tag's values, as numbers.
fn entry_values(b: &Bytes, field_type: u16, count: u64, value_at: u64, inline: u64, big: bool) -> Result<Vec<f64>, ParseError> {
    let Some(size) = type_size(field_type) else {
        return Ok(Vec::new());
    };
    let total = size * count;
    let at = if total <= inline {
        value_at
    } else {
        b.uint(value_at, if big { 8 } else { 4 })?
    };
    let mut out = Vec::with_capacity(count as usize);
    for i in 0..count {
        let p = at + i * size;
        let v = match field_type {
            1 | 2 | 7 => b.uint(p, 1)? as f64,
            6 => b.uint(p, 1)? as u8 as i8 as f64,
            3 => b.uint(p, 2)? as f64,
            8 => b.uint(p, 2)? as u16 as i16 as f64,
            4 | 13 => b.uint(p, 4)? as f64,
            9 => b.uint(p, 4)? as u32 as i32 as f64,
            11 => f32::from_bits(b.uint(p, 4)? as u32) as f64,
            12 => f64::from_bits(b.uint(p, 8)?),
            5 => b.uint(p, 4)? as f64 / b.uint(p + 4, 4)?.max(1) as f64,
            10 => (b.uint(p, 4)? as u32 as i32) as f64 / (b.uint(p + 4, 4)? as u32 as i32).max(1) as f64,
            16 | 18 => b.uint(p, 8)? as f64,
            17 => b.uint(p, 8)? as i64 as f64,
            _ => 0.0,
        };
        out.push(v);
    }
    Ok(out)
}

/// Tags read from each image directory.
const WANTED: [u16; 13] = [254, 256, 257, 258, 259, 277, 317, 322, 323, 324, 325, 33550, 33922];

fn parse_header(url: &str, data: &[u8]) -> Result<Cog, ParseError> {
    let little = match data.get(0..2) {
        Some(b"II") => true,
        Some(b"MM") => false,
        Some(_) => return Err(ParseError::Bad(format!("{url} is not a TIFF file"))),
        None => return Err(ParseError::NeedMore),
    };
    let b = Bytes { data, little };
    let version = b.uint(2, 2)?;
    let big = match version {
        42 => false,
        43 => true,
        _ => return Err(ParseError::Bad(format!("{url} is not a TIFF file"))),
    };
    let mut next = if big { b.uint(8, 8)? } else { b.uint(4, 4)? };

    let mut directories: Vec<HashMap<u16, Vec<f64>>> = Vec::new();
    while next != 0 && directories.len() < 64 {
        let (count, entry_size, first) = if big {
            (b.uint(next, 8)?, 20, next + 8)
        } else {
            (b.uint(next, 2)?, 12, next + 2)
        };
        let mut tags = HashMap::new();
        for i in 0..count {
            let e = first + i * entry_size;
            let tag = b.uint(e, 2)? as u16;
            if !WANTED.contains(&tag) {
                continue;
            }
            let field_type = b.uint(e + 2, 2)? as u16;
            let (n, value_at, inline) = if big {
                (b.uint(e + 4, 8)?, e + 12, 8)
            } else {
                (b.uint(e + 4, 4)?, e + 8, 4)
            };
            tags.insert(tag, entry_values(&b, field_type, n, value_at, inline, big)?);
        }
        directories.push(tags);
        let after = first + count * entry_size;
        next = if big { b.uint(after, 8)? } else { b.uint(after, 4)? };
    }

    let bad = |what: &str| ParseError::Bad(format!("{url}: {what}"));
    let first = directories.first().ok_or_else(|| bad("no image in file"))?;
    let one = |tags: &HashMap<u16, Vec<f64>>, tag: u16| tags.get(&tag).and_then(|v| v.first().copied());
    let scale = first.get(&33550).ok_or_else(|| bad("no pixel scale"))?.clone();
    let tie = first.get(&33922).ok_or_else(|| bad("no tie point"))?.clone();
    if scale.len() < 2 || tie.len() < 6 {
        return Err(bad("incomplete georeferencing"));
    }
    let width0 = one(first, 256).ok_or_else(|| bad("no width"))?;
    let extent_x = scale[0] * width0;

    let mut levels = Vec::new();
    for (i, tags) in directories.iter().enumerate() {
        // Keep the full image and its overviews and skip masks, as geotiff.js does.
        let reduced = one(tags, 254).unwrap_or(0.0) as u32 & 1 == 1;
        if i > 0 && !reduced {
            continue;
        }
        if one(tags, 277).unwrap_or(1.0) != 1.0 {
            return Err(bad("more than one band per file"));
        }
        let (Some(w), Some(h), Some(tw), Some(th), Some(offsets), Some(counts)) = (
            one(tags, 256),
            one(tags, 257),
            one(tags, 322),
            one(tags, 323),
            tags.get(&324),
            tags.get(&325),
        ) else {
            return Err(bad("an image in the file is not tiled"));
        };
        levels.push(Level {
            width: w as u32,
            height: h as u32,
            tile_width: tw as u32,
            tile_height: th as u32,
            resolution: extent_x / w,
            bits_per_sample: one(tags, 258).unwrap_or(1.0) as u16,
            compression: one(tags, 259).unwrap_or(1.0) as u16,
            predictor: one(tags, 317).unwrap_or(1.0) as u16,
            tile_offsets: offsets.iter().map(|&v| v as u64).collect(),
            tile_byte_counts: counts.iter().map(|&v| v as u64).collect(),
        });
    }
    Ok(Cog {
        url: url.to_string(),
        little_endian: little,
        origin_x: tie[3] - tie[0] * scale[0],
        origin_y: tie[4] + tie[1] * scale[1],
        levels,
    })
}

/// One HTTP range request, counted.
pub async fn fetch_range(client: &reqwest::Client, url: &str, start: u64, len: u64, traffic: &Traffic) -> Result<Vec<u8>, String> {
    let mut last = String::new();
    // Three attempts, as the checker makes, because one dropped connection in
    // thousands should not end a run.
    for attempt in 0..3 {
        let result = client
            .get(url)
            .header("Range", format!("bytes={}-{}", start, start + len - 1))
            .send()
            .await;
        match result {
            Ok(r) if r.status().is_success() => match r.bytes().await {
                Ok(bytes) => {
                    traffic.add(bytes.len() as u64);
                    return Ok(bytes.to_vec());
                }
                Err(e) => last = e.to_string(),
            },
            Ok(r) if r.status().as_u16() == 429 || r.status().is_server_error() => last = r.status().to_string(),
            Ok(r) => return Err(format!("{} returned {}", short(url), r.status())),
            Err(e) => last = e.to_string(),
        }
        let _ = attempt;
    }
    Err(format!(
        "The image {} could not be downloaded after 3 attempts ({last}). Running the check again usually works.",
        short(url)
    ))
}

/// The last two parts of a link, for messages.
pub fn short(url: &str) -> String {
    let path = url.split('?').next().unwrap_or(url);
    let parts: Vec<&str> = path.rsplit('/').take(2).collect();
    format!("{}/{}", parts.get(1).unwrap_or(&""), parts.first().unwrap_or(&""))
}

/// Read a COG's header, fetching 32 KiB first and more only if needed.
pub async fn open(client: &reqwest::Client, url: &str, traffic: &Traffic) -> Result<Cog, String> {
    let mut size: u64 = 32 * 1024;
    loop {
        let data = fetch_range(client, url, 0, size, traffic).await?;
        let short_file = (data.len() as u64) < size;
        match parse_header(url, &data) {
            Ok(cog) => return Ok(cog),
            Err(ParseError::Bad(message)) => return Err(message),
            Err(ParseError::NeedMore) if short_file || size >= 16 * 1024 * 1024 => {
                return Err(format!("{}: header incomplete", short(url)));
            }
            Err(ParseError::NeedMore) => size *= 4,
        }
    }
}

// ---------------------------------------------------------------- windows

/// JavaScript's `Math.round`, which rounds halves up, not away from zero.
fn js_round(v: f64) -> f64 {
    (v + 0.5).floor()
}

/// A window of whole pixels at one level, as geotiff.js cuts it.
#[derive(Clone, Copy, Debug)]
pub struct Window {
    pub x0: i64,
    pub y0: i64,
    pub x1: i64,
    pub y1: i64,
}

impl Cog {
    /// The level geotiff.js 3.0.5 reads for a request at this pixel size.
    ///
    /// geotiff.js walks the levels from coarsest to finest and stops at the
    /// first one strictly finer than the request. For a 20 m request on a
    /// 10 m band the 20 m overview is equal, not finer, so the full 10 m
    /// image is read.
    pub fn level_geotiff_js(&self, resolution: f64) -> usize {
        let mut order: Vec<usize> = (0..self.levels.len()).collect();
        order.sort_by_key(|&i| self.levels[i].width);
        let mut used = 0;
        for i in order {
            used = i;
            if resolution > self.levels[i].resolution {
                break;
            }
        }
        used
    }

    /// The coarsest level no coarser than this pixel size.
    pub fn level_at_most(&self, resolution: f64) -> usize {
        let mut best = 0;
        for (i, level) in self.levels.iter().enumerate() {
            if level.resolution <= resolution + 1e-6 && level.resolution > self.levels[best].resolution {
                best = i;
            }
        }
        best
    }

    /// The pixel window geotiff.js reads for a box in metres
    /// (west, south, east, north).
    pub fn window(&self, level: usize, bbox: [f64; 4]) -> Window {
        let l = &self.levels[level];
        let rx = l.resolution;
        let ry = -l.resolution;
        let a = [
            js_round((bbox[0] - self.origin_x) / rx),
            js_round((bbox[1] - self.origin_y) / ry),
            js_round((bbox[2] - self.origin_x) / rx),
            js_round((bbox[3] - self.origin_y) / ry),
        ];
        Window {
            x0: a[0].min(a[2]) as i64,
            y0: a[1].min(a[3]) as i64,
            x1: a[0].max(a[2]) as i64,
            y1: a[1].max(a[3]) as i64,
        }
    }

    /// Tile numbers a box touches at one level, as geotiff.js lists them.
    pub fn window_tiles(&self, level: usize, bbox: [f64; 4]) -> Vec<usize> {
        let l = &self.levels[level];
        let w = self.window(level, bbox);
        let (tw, th) = (l.tile_width as i64, l.tile_height as i64);
        let min_tx = w.x0.div_euclid(tw).max(0);
        let max_tx = (w.x1 + tw - 1).div_euclid(tw).min(l.width.div_ceil(l.tile_width) as i64);
        let min_ty = w.y0.div_euclid(th).max(0);
        let max_ty = (w.y1 + th - 1).div_euclid(th).min(l.height.div_ceil(l.tile_height) as i64);
        let across = l.tiles_across() as i64;
        let mut tiles = Vec::new();
        for ty in min_ty..max_ty {
            for tx in min_tx..max_tx {
                tiles.push((ty * across + tx) as usize);
            }
        }
        tiles
    }

    /// Bytes of a set of tiles at one level.
    pub fn tile_bytes(&self, level: usize, tiles: &BTreeSet<usize>) -> u64 {
        tiles.iter().map(|&t| self.levels[level].tile_byte_counts[t]).sum()
    }

    /// Bytes fetched when every read is widened to whole blocks of this size,
    /// as geotiff.js's BlockedSource does with 64 KiB.
    pub fn block_rounded_bytes(&self, level: usize, tiles: &BTreeSet<usize>, block: u64) -> u64 {
        let l = &self.levels[level];
        let mut blocks = BTreeSet::new();
        for &t in tiles {
            let (start, len) = (l.tile_offsets[t], l.tile_byte_counts[t]);
            if len == 0 {
                continue;
            }
            for b in start / block..=(start + len - 1) / block {
                blocks.insert(b);
            }
        }
        blocks.len() as u64 * block
    }
}

// ---------------------------------------------------------------- tiles

/// Fetch several tiles of one file, joining neighbours into one request when
/// the gap between them is small. Returns each tile's compressed bytes.
pub async fn fetch_tiles(
    client: &reqwest::Client,
    cog: &Cog,
    level: usize,
    tiles: &[usize],
    traffic: &Traffic,
) -> Result<Vec<(usize, Vec<u8>)>, String> {
    const MAX_GAP: u64 = 16 * 1024;
    const MAX_REQUEST: u64 = 8 * 1024 * 1024;
    let l = &cog.levels[level];
    let mut wanted: Vec<(u64, u64, usize)> = tiles
        .iter()
        .filter(|&&t| l.tile_byte_counts[t] > 0)
        .map(|&t| (l.tile_offsets[t], l.tile_byte_counts[t], t))
        .collect();
    wanted.sort();

    let mut out = Vec::with_capacity(wanted.len());
    let mut i = 0;
    while i < wanted.len() {
        let start = wanted[i].0;
        let mut end = wanted[i].0 + wanted[i].1;
        let mut j = i + 1;
        while j < wanted.len() && wanted[j].0 <= end + MAX_GAP && wanted[j].0 + wanted[j].1 - start <= MAX_REQUEST {
            end = end.max(wanted[j].0 + wanted[j].1);
            j += 1;
        }
        let data = fetch_range(client, &cog.url, start, end - start, traffic).await?;
        for &(offset, len, tile) in &wanted[i..j] {
            let from = (offset - start) as usize;
            let piece = data
                .get(from..from + len as usize)
                .ok_or_else(|| format!("{} returned fewer bytes than asked", short(&cog.url)))?;
            out.push((tile, piece.to_vec()));
        }
        i = j;
    }
    Ok(out)
}

/// Decompress one tile into whole numbers, one per pixel.
///
/// Handles what Sentinel-2 files on both hosts use: deflate compression,
/// horizontal differencing (Earth Search) and 15-bit packed samples
/// (Planetary Computer).
pub fn decode_tile(cog: &Cog, level: usize, compressed: &[u8]) -> Result<Vec<u16>, String> {
    let l = &cog.levels[level];
    let raw = match l.compression {
        1 => compressed.to_vec(),
        8 | 32946 => miniz_oxide::inflate::decompress_to_vec_zlib(compressed)
            .map_err(|e| format!("{}: a tile would not decompress ({e:?})", short(&cog.url)))?,
        other => return Err(format!("{}: compression {other} is not supported", short(&cog.url))),
    };
    let (w, h) = (l.tile_width as usize, l.tile_height as usize);
    let bits = l.bits_per_sample as usize;
    let mut out = vec![0u16; w * h];
    match bits {
        8 => {
            for (o, &v) in out.iter_mut().zip(raw.iter()) {
                *o = v as u16;
            }
        }
        16 => {
            for (i, o) in out.iter_mut().enumerate() {
                let (a, b) = (raw.get(2 * i).copied().unwrap_or(0), raw.get(2 * i + 1).copied().unwrap_or(0));
                *o = if cog.little_endian { u16::from_le_bytes([a, b]) } else { u16::from_be_bytes([a, b]) };
            }
        }
        1..=15 => {
            // Packed samples, most significant bit first, each row starting
            // on a fresh byte.
            let row_bytes = (w * bits).div_ceil(8);
            for y in 0..h {
                let row = &raw[(y * row_bytes).min(raw.len())..((y + 1) * row_bytes).min(raw.len())];
                for x in 0..w {
                    let mut v = 0u32;
                    let first_bit = x * bits;
                    for k in 0..bits {
                        let bit = first_bit + k;
                        let byte = row.get(bit / 8).copied().unwrap_or(0);
                        v = (v << 1) | ((byte >> (7 - bit % 8)) & 1) as u32;
                    }
                    out[y * w + x] = v as u16;
                }
            }
        }
        other => return Err(format!("{}: {other}-bit samples are not supported", short(&cog.url))),
    }
    match l.predictor {
        1 => {}
        2 => {
            for y in 0..h {
                let row = &mut out[y * w..(y + 1) * w];
                for x in 1..w {
                    row[x] = row[x].wrapping_add(row[x - 1]);
                }
                if bits == 8 {
                    for v in row.iter_mut() {
                        *v &= 0xff;
                    }
                }
            }
        }
        other => return Err(format!("{}: predictor {other} is not supported", short(&cog.url))),
    }
    Ok(out)
}

/// Pixels of one grid block from one file, as geotiff.js would return them:
/// the window read at `level`, then resampled to the block's size by nearest
/// pixel. Pixels off the image are 0, the no-data value.
pub fn sample_block(cog: &Cog, level: usize, bbox: [f64; 4], width: u32, height: u32, tiles: &HashMap<usize, Vec<u16>>) -> Vec<f32> {
    let l = &cog.levels[level];
    let w = cog.window(level, bbox);
    let (ww, wh) = (w.x1 - w.x0, w.y1 - w.y0);
    let mut out = vec![0f32; (width * height) as usize];
    if ww <= 0 || wh <= 0 {
        return out;
    }
    let rel_x = ww as f64 / width as f64;
    let rel_y = wh as f64 / height as f64;
    let (tw, th) = (l.tile_width as i64, l.tile_height as i64);
    let across = l.tiles_across() as i64;
    // Image column of each output column, computed once.
    let columns: Vec<i64> = (0..width as i64)
        .map(|x| w.x0 + (js_round(rel_x * x as f64) as i64).min(ww - 1))
        .collect();
    for y in 0..height as i64 {
        let iy = w.y0 + (js_round(rel_y * y as f64) as i64).min(wh - 1);
        if iy < 0 || iy >= l.height as i64 {
            continue;
        }
        let (ty, ry) = (iy / th, iy % th);
        let row_out = &mut out[(y * width as i64) as usize..((y + 1) * width as i64) as usize];
        for (x, &ix) in columns.iter().enumerate() {
            if ix < 0 || ix >= l.width as i64 {
                continue;
            }
            if let Some(tile) = tiles.get(&((ty * across + ix / tw) as usize)) {
                row_out[x] = tile[(ry * tw + ix % tw) as usize] as f32;
            }
        }
    }
    out
}
