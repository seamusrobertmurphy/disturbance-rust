//! Cloud-optimised GeoTIFF headers, read over HTTP.
//!
//! A cloud-optimised GeoTIFF (COG) is one image file cut into square tiles,
//! with smaller copies of itself, called overviews, stored in the same file.
//! Its header lists every tile's position and size in bytes, so the header
//! alone tells exactly how many bytes any window of the image costs to fetch.
//!
//! This file reads headers only. The checker's equivalent is
//! `src/raster/cog.ts`, which hands the work to geotiff.js; the functions
//! `level_geotiff_js` and `window_tiles` repeat geotiff.js 3.0.5's choices so
//! the checker's downloads can be predicted from here.
//!
//! Rust notes for this file.
//! A `trait` is a set of functions a type promises to provide, close to an R
//! generic such as `print`, which each class implements in its own way. Here
//! `CountingReader` implements async-tiff's `AsyncFileReader` trait, so
//! async-tiff can read through it without knowing it counts bytes.
//! `Arc<AtomicU64>` is a shared counter that several downloads running at the
//! same time can add to safely.

use std::collections::BTreeSet;
use std::ops::Range;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use async_tiff::error::AsyncTiffResult;
use async_tiff::metadata::TiffMetadataReader;
use async_tiff::metadata::cache::ReadaheadMetadataCache;
use async_tiff::reader::{AsyncFileReader, ReqwestReader};
use bytes::Bytes;

/// Bytes and requests sent over the network, shared across readers.
#[derive(Debug, Default)]
pub struct Traffic {
    pub bytes: AtomicU64,
    pub requests: AtomicU64,
}

/// async-tiff's HTTP reader with a byte counter on it.
#[derive(Debug, Clone)]
pub struct CountingReader {
    inner: ReqwestReader,
    traffic: Arc<Traffic>,
}

#[cfg_attr(target_arch = "wasm32", async_trait::async_trait(?Send))]
#[cfg_attr(not(target_arch = "wasm32"), async_trait::async_trait)]
impl AsyncFileReader for CountingReader {
    async fn get_bytes(&self, range: Range<u64>) -> AsyncTiffResult<Bytes> {
        let bytes = self.inner.get_bytes(range).await?;
        self.traffic.bytes.fetch_add(bytes.len() as u64, Ordering::Relaxed);
        self.traffic.requests.fetch_add(1, Ordering::Relaxed);
        Ok(bytes)
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
    pub compression: String,
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
    /// Upper left corner of the image in metres.
    pub origin_x: f64,
    pub origin_y: f64,
    /// Index 0 is the full image; the rest are overviews, coarsest last.
    pub levels: Vec<Level>,
}

/// Read a COG's header from a URL.
///
/// The header is fetched in growing pieces from the start of the file, 32 KiB
/// first, until every image directory has been read.
pub async fn open(client: &reqwest::Client, url: &str, traffic: Arc<Traffic>) -> Result<Cog, String> {
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("bad URL {url}: {e}"))?;
    let reader = CountingReader { inner: ReqwestReader::new(client.clone(), parsed), traffic };
    let fetch = ReadaheadMetadataCache::new(reader);
    let tiff = TiffMetadataReader::try_open(&fetch)
        .await
        .map_err(|e| format!("{url}: {e}"))?
        .read(&fetch)
        .await
        .map_err(|e| format!("{url}: {e}"))?;

    let ifds = tiff.ifds();
    let first = ifds.first().ok_or(format!("{url}: no image in file"))?;
    let scale = first.model_pixel_scale().ok_or(format!("{url}: no pixel scale"))?;
    let tiepoint = first.model_tiepoint().ok_or(format!("{url}: no tie point"))?;
    let full_extent_x = scale[0] * first.image_width() as f64;

    let mut levels = Vec::new();
    for (i, ifd) in ifds.iter().enumerate() {
        // Keep the full image and the overviews, skipping masks, as geotiff.js does.
        let reduced = ifd.new_subfile_type().unwrap_or(0) & 1 == 1;
        if i > 0 && !reduced {
            continue;
        }
        let (Some(tw), Some(th), Some(offsets), Some(counts)) =
            (ifd.tile_width(), ifd.tile_height(), ifd.tile_offsets(), ifd.tile_byte_counts())
        else {
            return Err(format!("{url}: image {i} is not tiled"));
        };
        levels.push(Level {
            width: ifd.image_width(),
            height: ifd.image_height(),
            tile_width: tw,
            tile_height: th,
            resolution: full_extent_x / ifd.image_width() as f64,
            compression: format!("{:?}", ifd.compression()),
            tile_offsets: offsets.to_vec(),
            tile_byte_counts: counts.to_vec(),
        });
    }
    Ok(Cog {
        url: url.to_string(),
        origin_x: tiepoint[3] - tiepoint[0] * scale[0],
        origin_y: tiepoint[4] + tiepoint[1] * scale[1],
        levels,
    })
}

/// JavaScript's `Math.round`, which rounds halves up, not away from zero.
fn js_round(v: f64) -> f64 {
    (v + 0.5).floor()
}

impl Cog {
    /// The level geotiff.js 3.0.5 reads for a request at this pixel size.
    ///
    /// geotiff.js walks the levels from coarsest to finest and stops at the
    /// first one strictly finer than the request. For a 20 m request on a
    /// 10 m band, the 20 m overview is equal, not finer, so it is passed over
    /// and the full 10 m image is read.
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

    /// The coarsest level no coarser than this pixel size: the 20 m overview
    /// of a 10 m band, or the full image of a 20 m band.
    pub fn level_at_most(&self, resolution: f64) -> usize {
        let mut best = 0;
        for (i, level) in self.levels.iter().enumerate() {
            if level.resolution <= resolution + 1e-6 && level.resolution > self.levels[best].resolution {
                best = i;
            }
        }
        best
    }

    /// Tile numbers that a box in metres (west, south, east, north) touches at
    /// one level, computed as geotiff.js computes its window and tile range.
    pub fn window_tiles(&self, level: usize, bbox: [f64; 4]) -> Vec<usize> {
        let l = &self.levels[level];
        let rx = l.resolution;
        let ry = -l.resolution;
        let a = [
            js_round((bbox[0] - self.origin_x) / rx),
            js_round((bbox[1] - self.origin_y) / ry),
            js_round((bbox[2] - self.origin_x) / rx),
            js_round((bbox[3] - self.origin_y) / ry),
        ];
        let (x0, x1) = (a[0].min(a[2]), a[0].max(a[2]));
        let (y0, y1) = (a[1].min(a[3]), a[1].max(a[3]));
        let (tw, th) = (l.tile_width as f64, l.tile_height as f64);
        let min_tx = (x0 / tw).floor().max(0.0) as i64;
        let max_tx = ((x1 / tw).ceil() as i64).min(l.width.div_ceil(l.tile_width) as i64);
        let min_ty = (y0 / th).floor().max(0.0) as i64;
        let max_ty = ((y1 / th).ceil() as i64).min(l.height.div_ceil(l.tile_height) as i64);
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

    /// Bytes fetched for a set of tiles when every read is widened to whole
    /// 64 KiB blocks, as geotiff.js's BlockedSource does.
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
