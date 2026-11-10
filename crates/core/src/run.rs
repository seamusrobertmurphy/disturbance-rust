//! One check from start to finish: search, read, composite, classify, draw.
//! Ported from `runPeriod` in `src/analysis/run.ts` of disturbance-checker-srm
//! 0.14.3, Sentinel-2 with the SCL mask.
//!
//! The steps and their order are the checker's. The one change is in reading:
//! every tile is downloaded once per run and kept until the last block that
//! needs it, where the checker downloads it again for each block. The pixels
//! are the same either way.
//!
//! Rust note. `async fn run(...)` returns a future, a task that has not run
//! yet. The command-line program runs it with Tokio and the web page with the
//! browser's own event loop, so the same code serves both, as the brief asks.

use std::collections::{BTreeSet, HashMap};

use futures::stream::{self, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use web_time::Instant;

use crate::cog::{self, Cog, Traffic};
use crate::composite::{self, ATMOSPHERE_BANDS, CompositeBlock, INDEX_BANDS, RGB_EXTRA_BANDS, SceneBlock};
use crate::defaults::{AOT_DIFFERENCE_WARNING, Breaks, CLASS_NODATA, DEFAULT_MAX_CLOUD, DeltaId, MIN_STABLE_SCENE_COUNT, RGB_OBSERVATION_COUNT};
use crate::deltas::{self, Histogram, Normalisation};
use crate::grid::{self, BLOCK_SIZE, GRID_RESOLUTION, TargetGrid};
use crate::mask::MaskOptions;
use crate::patches::{self, Patch};
use crate::rasterize;
use crate::render;
use crate::stac::{self, Band, Host, Observation, SearchParams};

/// The project boundary: a box in degrees, or any GeoJSON with polygons.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Aoi {
    /// West, south, east, north.
    Rectangle { bbox: [f64; 4] },
    Geojson { geometry: Value },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RunParams {
    pub aoi: Aoi,
    pub pre_start: String,
    pub pre_end: String,
    pub post_start: String,
    pub post_end: String,
    #[serde(default = "default_host")]
    pub host: Host,
    /// The checker's scene-wide shift of the breaks, on by default there.
    #[serde(default = "yes")]
    pub normalise: bool,
    #[serde(default = "default_cloud")]
    pub max_cloud: f64,
    #[serde(default)]
    pub mask: MaskOptions,
    /// Simultaneous downloads.
    #[serde(default = "default_concurrency")]
    pub concurrency: usize,
}

fn default_host() -> Host {
    Host::EarthSearch
}
fn yes() -> bool {
    true
}
fn default_cloud() -> f64 {
    DEFAULT_MAX_CLOUD
}
fn default_concurrency() -> usize {
    12
}

#[derive(Clone, Debug, Serialize)]
pub struct ObservationSummary {
    pub date: String,
    pub cloud_cover: f64,
    pub tiles: Vec<String>,
    pub scenes: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct DeltaResult {
    pub id: DeltaId,
    pub meaning: String,
    pub histogram: Histogram,
    pub breaks_default: Breaks,
    pub breaks_used: Breaks,
    pub normalisation: Normalisation,
    pub patches_total: usize,
    /// Pixels per class, for checking the port against the checker only.
    #[serde(skip)]
    pub class_counts: [u64; 3],
}

#[derive(Clone, Debug, Serialize)]
pub struct Layer {
    pub key: String,
    pub name: String,
    /// West, south, east, north in degrees.
    pub bounds: [f64; 4],
    #[serde(skip)]
    pub png: Vec<u8>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Atmosphere {
    pub pre_aot: f64,
    pub post_aot: f64,
    pub pre_wvp: f64,
    pub post_wvp: f64,
}

/// Seconds and bytes, for the speed comparison with the checker.
#[derive(Clone, Debug, Default, Serialize)]
pub struct Stats {
    pub search_s: f64,
    pub headers_s: f64,
    pub download_s: f64,
    pub decode_s: f64,
    pub method_s: f64,
    pub draw_s: f64,
    pub total_s: f64,
    pub bytes: u64,
    pub requests: u64,
    pub files: usize,
    pub blocks: usize,
}

#[derive(Clone, Debug, Serialize)]
pub struct RunResult {
    pub host: String,
    pub epsg: u32,
    pub grid_width: u32,
    pub grid_height: u32,
    pub pre: Vec<ObservationSummary>,
    pub post: Vec<ObservationSummary>,
    pub deltas: Vec<DeltaResult>,
    pub layers: Vec<Layer>,
    pub patches: Vec<Patch>,
    pub observed_pixels: u64,
    pub thin_pixels: u64,
    pub atmosphere: Option<Atmosphere>,
    pub warnings: Vec<String>,
    pub stats: Stats,
}

/// The two names of the Earth Search bucket. A browser holds about six
/// connections per name, so splitting files across both doubles the
/// downloads in flight. The checker's `shardHref`, same hash.
const PIXEL_HOSTS: [&str; 2] = ["https://sentinel-cogs.s3.us-west-2.amazonaws.com/", "https://s3.us-west-2.amazonaws.com/sentinel-cogs/"];

fn shard(href: &str) -> String {
    let Some(key) = href.strip_prefix(PIXEL_HOSTS[0]) else {
        return href.to_string();
    };
    let mut hash: i32 = 0;
    for unit in key.encode_utf16() {
        hash = hash.wrapping_mul(31).wrapping_add(unit as i32);
    }
    format!("{}{key}", PIXEL_HOSTS[(hash.unsigned_abs() % 2) as usize])
}

/// The checker's `rgbSubsetOf`: the three least cloudy observations, ties
/// kept in date order as JavaScript's stable sort keeps them.
fn rgb_subset(observations: &[Observation]) -> Vec<usize> {
    let mut order: Vec<usize> = (0..observations.len()).collect();
    order.sort_by(|&a, &b| observations[a].cloud_cover.total_cmp(&observations[b].cloud_cover));
    order.truncate(RGB_OBSERVATION_COUNT);
    order
}

/// One file the run reads, and where its pixels go.
struct FileRead {
    cog: Cog,
    level: usize,
    /// Tiles each block needs.
    tiles_by_block: Vec<Vec<usize>>,
    /// The last block that needs each tile, so it can be dropped after.
    last_use: HashMap<usize, usize>,
}

/// Which file holds each band of each scene of each observation.
struct Plan {
    /// For each observation, the bands to read and, per band, one file index
    /// per scene, in the scenes' order.
    windows: [Vec<Vec<(Band, Vec<usize>)>>; 2],
    urls: Vec<String>,
}

fn plan(pre: &[Observation], post: &[Observation]) -> Plan {
    let mut urls: Vec<String> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    let mut windows: [Vec<Vec<(Band, Vec<usize>)>>; 2] = [Vec::new(), Vec::new()];
    for (w, observations) in [pre, post].into_iter().enumerate() {
        let subset: BTreeSet<usize> = rgb_subset(observations).into_iter().collect();
        for (i, observation) in observations.iter().enumerate() {
            let mut bands: Vec<Band> = INDEX_BANDS.to_vec();
            bands.push(Band::Scl);
            if subset.contains(&i) {
                bands.extend(RGB_EXTRA_BANDS);
                bands.extend(ATMOSPHERE_BANDS);
            }
            let mut reads = Vec::new();
            for band in bands {
                let files: Vec<usize> = observation
                    .scenes
                    .iter()
                    .filter_map(|s| s.hrefs.get(&band))
                    .map(|url| {
                        *index.entry(url.clone()).or_insert_with(|| {
                            urls.push(url.clone());
                            urls.len() - 1
                        })
                    })
                    .collect();
                if !files.is_empty() {
                    reads.push((band, files));
                }
            }
            windows[w].push(reads);
        }
    }
    Plan { windows, urls }
}

fn scatter<T: Copy>(destination: &mut [T], source: &[T], block: &grid::GridBlock, grid: &TargetGrid) {
    for row in 0..block.height as usize {
        let from = row * block.width as usize;
        let to = (block.y as usize + row) * grid.width as usize + block.x as usize;
        destination[to..to + block.width as usize].copy_from_slice(&source[from..from + block.width as usize]);
    }
}

fn summary(observations: &[Observation]) -> Vec<ObservationSummary> {
    observations
        .iter()
        .map(|o| ObservationSummary {
            date: o.date.clone(),
            cloud_cover: o.cloud_cover,
            tiles: o.scenes.iter().map(|s| s.tile.clone()).collect(),
            scenes: o.scenes.iter().map(|s| s.id.clone()).collect(),
        })
        .collect()
}

/// Run the check. `progress` receives a message and the fraction done.
pub async fn run(client: &reqwest::Client, params: &RunParams, progress: &dyn Fn(&str, f64)) -> Result<RunResult, String> {
    let started = Instant::now();
    let mut stats = Stats::default();
    let traffic = Traffic::default();

    let bounds = match &params.aoi {
        Aoi::Rectangle { bbox } => Some([bbox[0].min(bbox[2]), bbox[1].min(bbox[3]), bbox[0].max(bbox[2]), bbox[1].max(bbox[3])]),
        Aoi::Geojson { geometry } => rasterize::bounds_of(geometry),
    }
    .ok_or("The boundary encloses no area. Draw a rectangle or load a boundary with at least one polygon.")?;

    // 1. Search.
    progress("Searching the catalogue", 0.0);
    let window = |start: &str, end: &str| SearchParams { bbox: bounds, start: start.into(), end: end.into(), max_cloud: params.max_cloud };
    let (pre_params, post_params) = (window(&params.pre_start, &params.pre_end), window(&params.post_start, &params.post_end));
    let (mut pre_all, mut post_all) = futures::try_join!(
        stac::search(client, params.host, &pre_params),
        stac::search(client, params.host, &post_params)
    )?;
    if pre_all.is_empty() || post_all.is_empty() {
        return Err(format!(
            "The catalogue returned {} scenes before and {} after. Widen the date windows or raise the cloud ceiling.",
            pre_all.len(),
            post_all.len()
        ));
    }
    if params.host == Host::PlanetaryComputer {
        let token = stac::planetary_computer_token(client).await?;
        stac::sign(&mut pre_all, &token);
        stac::sign(&mut post_all, &token);
    }
    for scene in pre_all.iter_mut().chain(post_all.iter_mut()) {
        for href in scene.hrefs.values_mut() {
            *href = shard(href);
        }
    }
    stats.search_s = started.elapsed().as_secs_f64();

    // 2. The grid and the observations on it.
    let natural = grid::utm_epsg_for_lon_lat((bounds[0] + bounds[2]) / 2.0, (bounds[1] + bounds[3]) / 2.0);
    let all: Vec<_> = pre_all.iter().chain(post_all.iter()).cloned().collect();
    let epsg = stac::best_epsg_for(&all, natural).unwrap_or(natural);
    let target = grid::grid_for_bounds(epsg, bounds, GRID_RESOLUTION)?;
    let pre = stac::observations_on_grid(&pre_all, epsg);
    let post = stac::observations_on_grid(&post_all, epsg);

    let mut warnings = Vec::new();
    let unreachable = stac::unreachable_count(&pre_all, epsg) + stac::unreachable_count(&post_all, epsg);
    if unreachable > 0 {
        warnings.push(format!(
            "{unreachable} overpass(es) exist for this area but have no tile on the working grid (EPSG:{epsg}), so they were not used. This happens when an area straddles a UTM zone boundary."
        ));
    }
    let uncorrected = pre.iter().chain(post.iter()).flat_map(|o| o.scenes.iter()).filter(|s| s.boa_offset_correction() != 0.0).count();
    if uncorrected > 0 {
        warnings.push(format!("{uncorrected} scene(s) still carried the +1000 DN baseline offset and were corrected before compositing."));
    }
    for (label, observations) in [("pre", &pre), ("post", &post)] {
        if observations.len() < MIN_STABLE_SCENE_COUNT {
            warnings.push(format!(
                "The {label} window kept only {} overpass(es). The SOP puts the median's stability floor at {MIN_STABLE_SCENE_COUNT}, and below it the composite can move with a single observation.",
                observations.len()
            ));
        }
    }

    let blocks = grid::blocks_for(&target, BLOCK_SIZE);
    stats.blocks = blocks.len();
    let aoi_mask = match &params.aoi {
        Aoi::Geojson { geometry } => {
            let m = rasterize::rasterize_aoi(geometry, &target)?;
            if m.is_none() {
                warnings.push("The loaded boundary contained no polygon, so the whole bounding box was analysed.".into());
            }
            m
        }
        Aoi::Rectangle { .. } => None,
    };

    // 3. Headers of every file, then which tiles each block needs.
    let plan = plan(&pre, &post);
    progress(&format!("Reading {} image headers", plan.urls.len()), 0.02);
    let clock = Instant::now();
    let opened: Vec<Result<Cog, String>> = stream::iter(plan.urls.iter())
        .map(|url| cog::open(client, url, &traffic))
        .buffered(params.concurrency)
        .collect()
        .await;
    let mut files: Vec<FileRead> = Vec::with_capacity(opened.len());
    for result in opened {
        let cog = result?;
        let level = cog.level_geotiff_js(GRID_RESOLUTION);
        let tiles_by_block: Vec<Vec<usize>> = blocks.iter().map(|b| cog.window_tiles(level, b.bbox)).collect();
        let mut last_use = HashMap::new();
        for (b, tiles) in tiles_by_block.iter().enumerate() {
            for &t in tiles {
                last_use.insert(t, b);
            }
        }
        files.push(FileRead { cog, level, tiles_by_block, last_use });
    }
    stats.headers_s = clock.elapsed().as_secs_f64();
    stats.files = files.len();

    // 4. Block by block.
    let total = (target.width * target.height) as usize;
    let mut histograms = [Histogram::new(), Histogram::new(), Histogram::new()];
    let mut delta_grid = [vec![f32::NAN; total], vec![f32::NAN; total], vec![f32::NAN; total]];
    let mut rgb_grid: [[Vec<f32>; 3]; 2] = [
        [vec![f32::NAN; total], vec![f32::NAN; total], vec![f32::NAN; total]],
        [vec![f32::NAN; total], vec![f32::NAN; total], vec![f32::NAN; total]],
    ];
    let mut atmosphere_sums = [[composite::Sum::default(); 2]; 2];
    let (mut observed_pixels, mut thin_pixels) = (0u64, 0u64);
    let mut cache: HashMap<(usize, usize), Vec<u8>> = HashMap::new();
    let subsets = [rgb_subset(&pre), rgb_subset(&post)];

    for (b, block) in blocks.iter().enumerate() {
        progress(
            &format!("Block {} of {}, reading {} overpasses", b + 1, blocks.len(), pre.len() + post.len()),
            0.05 + 0.85 * b as f64 / blocks.len() as f64,
        );

        // Download the tiles this block needs that are not held already.
        let clock = Instant::now();
        let wanted: Vec<(usize, Vec<usize>)> = files
            .iter()
            .enumerate()
            .map(|(f, file)| (f, file.tiles_by_block[b].iter().copied().filter(|t| !cache.contains_key(&(f, *t))).collect::<Vec<_>>()))
            .filter(|(_, tiles)| !tiles.is_empty())
            .collect();
        let fetched: Vec<Result<(usize, Vec<(usize, Vec<u8>)>), String>> = stream::iter(wanted)
            .map(|(f, tiles)| {
                let file = &files[f];
                let traffic = &traffic;
                async move { cog::fetch_tiles(client, &file.cog, file.level, &tiles, traffic).await.map(|t| (f, t)) }
            })
            .buffer_unordered(params.concurrency)
            .collect()
            .await;
        for result in fetched {
            let (f, tiles) = result?;
            for (t, bytes) in tiles {
                cache.insert((f, t), bytes);
            }
        }
        stats.download_s += clock.elapsed().as_secs_f64();

        // Decode and sample every file onto the block.
        let clock = Instant::now();
        let mut sampled: HashMap<usize, Vec<f32>> = HashMap::new();
        for (f, file) in files.iter().enumerate() {
            let mut decoded = HashMap::new();
            for &t in &file.tiles_by_block[b] {
                if let Some(bytes) = cache.get(&(f, t)) {
                    decoded.insert(t, cog::decode_tile(&file.cog, file.level, bytes)?);
                }
            }
            sampled.insert(f, cog::sample_block(&file.cog, file.level, block.bbox, block.width, block.height, &decoded));
        }
        // Drop tiles no later block needs.
        for (f, file) in files.iter().enumerate() {
            for &t in &file.tiles_by_block[b] {
                if file.last_use.get(&t) == Some(&b) {
                    cache.remove(&(f, t));
                }
            }
        }
        stats.decode_s += clock.elapsed().as_secs_f64();

        // The method.
        let clock = Instant::now();
        let length = (block.width * block.height) as usize;
        let mut composites: Vec<CompositeBlock> = Vec::with_capacity(2);
        for (w, observations) in [&pre, &post].into_iter().enumerate() {
            let scene_blocks: Vec<SceneBlock> = plan.windows[w]
                .iter()
                .map(|reads| {
                    let mut out = SceneBlock::new();
                    for (band, file_indices) in reads {
                        // Tiles of one overpass: the first with data wins.
                        if file_indices.len() == 1 {
                            out.insert(*band, sampled[&file_indices[0]].clone());
                            continue;
                        }
                        let mut merged = vec![0f32; length];
                        for (i, m) in merged.iter_mut().enumerate() {
                            for f in file_indices {
                                let v = sampled[f][i];
                                if v != 0.0 {
                                    *m = v;
                                    break;
                                }
                            }
                        }
                        out.insert(*band, merged);
                    }
                    out
                })
                .collect();
            composites.push(composite::build_composite(observations, &scene_blocks, params.mask, length, &subsets[w]));
        }
        let (mut pre_c, mut post_c) = {
            let post_c = composites.pop().unwrap();
            (composites.pop().unwrap(), post_c)
        };
        for (w, c) in [&pre_c, &post_c].into_iter().enumerate() {
            for (k, band) in ATMOSPHERE_BANDS.iter().enumerate() {
                if let Some(held) = c.atmosphere.get(band) {
                    atmosphere_sums[w][k].sum += held.sum;
                    atmosphere_sums[w][k].count += held.count;
                }
            }
        }
        let mut d = deltas::compute_deltas(&pre_c, &post_c);
        if let Some(mask) = &aoi_mask {
            let clip = rasterize::mask_for_block(mask, block, &target);
            for delta in d.iter_mut() {
                for (v, &inside) in delta.iter_mut().zip(&clip) {
                    if inside == 0 {
                        *v = f32::NAN;
                    }
                }
            }
            for (i, &inside) in clip.iter().enumerate() {
                if inside == 0 {
                    pre_c.counts[i] = 0;
                    post_c.counts[i] = 0;
                }
            }
        }
        for k in 0..3 {
            histograms[k].accumulate(&d[k]);
            scatter(&mut delta_grid[k], &d[k], block, &target);
        }
        for i in 0..length {
            let seen = pre_c.counts[i].min(post_c.counts[i]) as usize;
            if seen > 0 {
                observed_pixels += 1;
            }
            if seen > 0 && seen < MIN_STABLE_SCENE_COUNT {
                thin_pixels += 1;
            }
        }
        for (w, c) in [&pre_c, &post_c].into_iter().enumerate() {
            for k in 0..3 {
                scatter(&mut rgb_grid[w][k], &c.rgb[k], block, &target);
            }
        }
        stats.method_s += clock.elapsed().as_secs_f64();
    }

    // 5. Shift, classes and patches.
    let clock = Instant::now();
    let mut delta_results = Vec::new();
    let mut classified: Vec<Vec<u8>> = Vec::new();
    let mut all_patches = Vec::new();
    for id in DeltaId::ALL {
        let k = deltas::delta_index(id);
        let normalisation = deltas::normalisation_offset(&histograms[k]);
        let breaks_default = id.default_breaks();
        let breaks_used = if params.normalise && normalisation.applicable {
            deltas::shift_breaks(breaks_default, normalisation.offset)
        } else {
            breaks_default
        };
        let classes = deltas::classify_delta(&delta_grid[k], breaks_used);
        let (found, patches_total) = patches::find_patches(id, &classes, &delta_grid[k], &target, 200)?;
        all_patches.extend(found);
        delta_results.push(DeltaResult {
            id,
            meaning: id.meaning().into(),
            histogram: histograms[k].clone(),
            breaks_default,
            breaks_used,
            normalisation,
            patches_total,
            class_counts: deltas::class_counts(&classes),
        });
        classified.push(classes);
    }
    stats.method_s += clock.elapsed().as_secs_f64();

    // 6. Map images.
    progress("Drawing the map layers", 0.92);
    let clock = Instant::now();
    let warp = render::build_warp(&target, 2048)?;
    let mut layers = Vec::new();
    for (w, name) in [(0, "Before, true colour"), (1, "After, true colour")] {
        let [r, g, b] = &rgb_grid[w];
        layers.push(Layer {
            key: if w == 0 { "pre-rgb".into() } else { "post-rgb".into() },
            name: name.into(),
            bounds: warp.bounds,
            png: render::png(&render::paint_rgb(r, g, b, &warp), warp.width, warp.height)?,
        });
    }
    for id in DeltaId::ALL {
        let k = deltas::delta_index(id);
        layers.push(Layer {
            key: id.name().into(),
            name: format!("{} classes, {}", id.name(), id.meaning()),
            bounds: warp.bounds,
            png: render::png(&render::paint_classified(&classified[k], id.palette(), &warp), warp.width, warp.height)?,
        });
    }
    stats.draw_s = clock.elapsed().as_secs_f64();

    if thin_pixels > 0 && observed_pixels > 0 {
        let share = 100.0 * thin_pixels as f64 / observed_pixels as f64;
        if share >= 1.0 {
            warnings.push(format!("{share:.1} percent of observed pixels had fewer than {MIN_STABLE_SCENE_COUNT} clear looks in one of the two windows."));
        }
    }
    let mean = |s: composite::Sum| if s.count > 0 { s.sum / s.count as f64 } else { f64::NAN };
    let atmosphere = {
        let a = Atmosphere {
            pre_aot: mean(atmosphere_sums[0][0]),
            post_aot: mean(atmosphere_sums[1][0]),
            pre_wvp: mean(atmosphere_sums[0][1]),
            post_wvp: mean(atmosphere_sums[1][1]),
        };
        if a.pre_aot.is_finite() && a.post_aot.is_finite() {
            let difference = (a.pre_aot - a.post_aot).abs();
            if difference >= AOT_DIFFERENCE_WARNING {
                warnings.push(format!(
                    "Aerosol optical thickness averaged {:.2} before and {:.2} after, a difference of {difference:.2}. Sen2Cor corrected each window for its own atmosphere, so this is not a residual error, but a gap this size means the two composites were retrieved through visibly different air and a marginal delta is worth confirming against the imagery.",
                    a.pre_aot, a.post_aot
                ));
            }
            Some(a)
        } else {
            None
        }
    };
    let _ = CLASS_NODATA;

    stats.bytes = traffic.bytes();
    stats.requests = traffic.requests();
    stats.total_s = started.elapsed().as_secs_f64();
    progress("Done", 1.0);
    Ok(RunResult {
        host: params.host.name().into(),
        epsg,
        grid_width: target.width,
        grid_height: target.height,
        pre: summary(&pre),
        post: summary(&post),
        deltas: delta_results,
        layers,
        patches: all_patches,
        observed_pixels,
        thin_pixels,
        atmosphere,
        warnings,
        stats,
    })
}
