//! The Sentinel-1 radar check, canopy loss as a drop in VH backscatter.
//! Ported from `src/analysis/radar.ts` and `src/stac/radar-search.ts` in
//! disturbance-checker-srm 0.14.3, which reproduce the Radar canopy loss cell
//! of the ArcGIS Pro notebook step for step.
//!
//! Radar sends its own signal, so it sees through cloud and darkness and is
//! not hidden by snow. VH, sent vertically and received horizontally, comes
//! back mostly from branches and stems, so it falls when a stand is cut.
//!
//! The steps, as the checker takes them.
//! 1. Find every Sentinel-1 RTC scene over the boundary in each window, on
//!    Microsoft Planetary Computer, which answers a browser with no account.
//! 2. Keep only the relative orbits seen in both windows, so each pixel is
//!    compared with itself seen from the same side and angle.
//! 3. Take each window's per-pixel median of VH in decibels.
//! 4. Smooth each window with a 25 m mean, which at 20 m is the pixel and its
//!    eight neighbours.
//! 5. Take the earlier window less the later, so a positive value is loss.
//! 6. Take the median of that drop over the boundary off every pixel, so a
//!    change across the whole scene is not read as loss. Unlike the optical
//!    shift this is always done, because the breaks were set after it.
//! 7. Drop water, where VH is below -22 dB in either window, and classify.
//!
//! As in the optical run, each image tile is downloaded once per run, where
//! the checker downloads it again for each block.

use std::collections::{BTreeSet, HashMap};

use futures::stream::{self, StreamExt};
use serde_json::{Value, json};
use web_time::Instant;

use crate::cog::{self, Cog, Traffic};
use crate::defaults::{DeltaId, Sensor};
use crate::deltas::{Histogram, Normalisation};
use crate::grid::{self, BLOCK_SIZE, GRID_RESOLUTION};
use crate::rasterize;
use crate::render;
use crate::run::{self, Analysis, Aoi, Layer, ObservationSummary, RadarReport, RunParams, RunResult, Stats};

/// Planetary Computer's catalogue and its Sentinel-1 RTC collection.
/// https://planetarycomputer.microsoft.com/dataset/sentinel-1-rtc
pub const SEARCH_URL: &str = "https://planetarycomputer.microsoft.com/api/stac/v1/search";
pub const COLLECTION: &str = "sentinel-1-rtc";
/// The anonymous read token for the RTC blobs, good for about an hour.
pub const TOKEN_URL: &str = "https://planetarycomputer.microsoft.com/api/sas/v1/token/sentinel1euwestrtc/sentinel1-grd-rtc";

/// Radius of the mean that quiets speckle, in metres, as the notebook.
pub const SMOOTH_M: f64 = 25.0;
/// Below this VH in decibels, a pixel is taken as water or smooth ground.
pub const WATER_FLOOR_DB: f64 = -22.0;
/// Below this many scenes a window's median rests on too few looks.
pub const MIN_SCENES: usize = 3;
/// The RTC files' no-data value.
const NODATA: f32 = -32768.0;
/// Grey stretch of the before and after VH pictures, in decibels.
const VH_MIN: f64 = -25.0;
const VH_MAX: f64 = -10.0;

#[derive(Clone, Debug)]
pub struct RadarScene {
    pub id: String,
    pub datetime: String,
    pub date: String,
    pub epsg: u32,
    pub orbit: u32,
    pub pass: String,
    pub platform: String,
    pub vh_href: String,
}

fn to_rfc3339(value: &str) -> String {
    if value.contains(':') { value.to_string() } else { format!("{value}T00:00:00Z") }
}

/// One catalogue entry, or None when it cannot serve the check. Only
/// interferometric wide swath scenes with a VH channel are kept.
fn parse_feature(feature: &Value) -> Option<RadarScene> {
    let p = feature.get("properties")?;
    let epsg = p
        .get("proj:epsg")
        .and_then(Value::as_u64)
        .or_else(|| p.get("proj:code").and_then(Value::as_str).and_then(|c| c.strip_prefix("EPSG:")).and_then(|c| c.parse().ok()))?
        as u32;
    let datetime = p.get("datetime")?.as_str()?.to_string();
    let orbit = p.get("sat:relative_orbit")?.as_u64()? as u32;
    if p.get("sar:instrument_mode").and_then(Value::as_str) != Some("IW") {
        return None;
    }
    let polarisations = p.get("sar:polarizations")?.as_array()?;
    if !polarisations.iter().any(|v| v.as_str() == Some("VH")) {
        return None;
    }
    let href = feature.get("assets")?.get("vh")?.get("href")?.as_str()?;
    if !href.starts_with("https://") {
        return None;
    }
    Some(RadarScene {
        id: feature.get("id")?.as_str()?.to_string(),
        date: datetime.get(0..10)?.to_string(),
        datetime,
        epsg,
        orbit,
        pass: p.get("sat:orbit_state").and_then(Value::as_str).unwrap_or("unknown").to_string(),
        platform: p.get("platform").and_then(Value::as_str).unwrap_or("sentinel-1").to_lowercase(),
        vh_href: href.to_string(),
    })
}

/// Every RTC scene over the box between two dates, oldest first.
pub async fn search(client: &reqwest::Client, bbox: [f64; 4], start: &str, end: &str) -> Result<Vec<RadarScene>, String> {
    let mut body = json!({
        "collections": [COLLECTION],
        "bbox": bbox,
        "datetime": format!("{}/{}", to_rfc3339(start), to_rfc3339(end)),
        "limit": 100,
    });
    let mut url = SEARCH_URL.to_string();
    let mut collected = Vec::new();
    for _ in 0..20 {
        let response = client.post(&url).json(&body).send().await.map_err(|e| format!("Planetary Computer radar search failed: {e}"))?;
        if !response.status().is_success() {
            return Err(format!(
                "Planetary Computer returned {}. The catalogue may be briefly unavailable; try again in a moment.",
                response.status()
            ));
        }
        let page: Value = response.json().await.map_err(|e| format!("Planetary Computer sent a page that is not a STAC item collection: {e}"))?;
        if let Some(features) = page.get("features").and_then(Value::as_array) {
            collected.extend(features.iter().filter_map(parse_feature));
        }
        let next = page
            .get("links")
            .and_then(Value::as_array)
            .and_then(|links| links.iter().find(|l| l.get("rel").and_then(Value::as_str) == Some("next")));
        match next.and_then(|l| Some((l.get("href")?.as_str()?.to_string(), l.get("body")?.clone()))) {
            Some((href, next_body)) => {
                url = href;
                body = next_body;
            }
            None => break,
        }
    }
    let mut seen = BTreeSet::new();
    collected.retain(|s| seen.insert(s.id.clone()));
    collected.sort_by(|a, b| a.datetime.cmp(&b.datetime));
    Ok(collected)
}

async fn read_token(client: &reqwest::Client) -> Result<String, String> {
    let response = client.get(TOKEN_URL).send().await.map_err(|e| format!("Planetary Computer radar token request failed: {e}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("Planetary Computer would not issue a read token ({status}). Try again in a moment."));
    }
    let reply: Value = response.json().await.map_err(|e| format!("Planetary Computer token reply unreadable: {e}"))?;
    reply.get("token").and_then(Value::as_str).map(str::to_string).ok_or_else(|| "Planetary Computer returned no read token.".into())
}

/// The relative orbits imaged in both windows, and each window cut to them.
pub fn same_orbits(pre: &[RadarScene], post: &[RadarScene]) -> (Vec<u32>, Vec<RadarScene>, Vec<RadarScene>) {
    let in_post: BTreeSet<u32> = post.iter().map(|s| s.orbit).collect();
    let orbits: Vec<u32> = pre.iter().map(|s| s.orbit).collect::<BTreeSet<_>>().into_iter().filter(|o| in_post.contains(o)).collect();
    let keep: BTreeSet<u32> = orbits.iter().copied().collect();
    let cut = |scenes: &[RadarScene]| scenes.iter().filter(|s| keep.contains(&s.orbit)).cloned().collect::<Vec<_>>();
    (orbits.clone(), cut(pre), cut(post))
}

/// The UTM zone that reaches the most scenes, the preferred zone winning a
/// tie, counted in the order scenes were first seen as the checker's Map is.
pub fn best_epsg(scenes: &[RadarScene], preferred: u32) -> Option<u32> {
    let mut order: Vec<u32> = Vec::new();
    let mut counts: HashMap<u32, usize> = HashMap::new();
    for s in scenes {
        if !counts.contains_key(&s.epsg) {
            order.push(s.epsg);
        }
        *counts.entry(s.epsg).or_insert(0) += 1;
    }
    let mut winner = None;
    let mut best: i64 = -1;
    for epsg in order {
        let count = counts[&epsg] as i64;
        if count > best || (count == best && epsg == preferred) {
            best = count;
            winner = Some(epsg);
        }
    }
    winner
}

/// Linear power to decibels; no data and power at or below zero become NaN.
fn to_decibels(values: &mut [f32]) {
    for v in values.iter_mut() {
        *v = if *v == NODATA || !(*v > 0.0) { f32::NAN } else { (10.0 * (*v as f64).log10()) as f32 };
    }
}

/// Median of the values that are not NaN, the even case averaged.
fn median_f64(values: &mut [f64]) -> f64 {
    values.sort_by(f64::total_cmp);
    let n = values.len();
    if n == 0 {
        f64::NAN
    } else if n % 2 == 1 {
        values[(n - 1) / 2]
    } else {
        (values[n / 2 - 1] + values[n / 2]) / 2.0
    }
}

/// Per-pixel median across scenes, ignoring NaN.
fn median_stack(stack: &[Vec<f32>], length: usize) -> Vec<f32> {
    let mut out = vec![f32::NAN; length];
    let mut column = Vec::with_capacity(stack.len());
    for (i, o) in out.iter_mut().enumerate() {
        column.clear();
        column.extend(stack.iter().map(|layer| layer[i]).filter(|v| !v.is_nan()).map(|v| v as f64));
        if !column.is_empty() {
            *o = median_f64(&mut column) as f32;
        }
    }
    out
}

/// Circular mean over the whole grid, NaN-aware. A pixel with no value stays
/// empty rather than being filled from its neighbours.
fn focal_mean(values: &[f32], width: usize, height: usize, radius: f64) -> Vec<f32> {
    let r = radius.ceil().max(1.0) as i64;
    let mut offsets = Vec::new();
    for dy in -r..=r {
        for dx in -r..=r {
            if (dx * dx + dy * dy) as f64 <= radius * radius + 1e-9 || (dx == 0 && dy == 0) {
                offsets.push((dx, dy));
            }
        }
    }
    let mut out = vec![f32::NAN; values.len()];
    for y in 0..height as i64 {
        for x in 0..width as i64 {
            let centre = (y * width as i64 + x) as usize;
            if values[centre].is_nan() {
                continue;
            }
            let (mut sum, mut n) = (0f64, 0u32);
            for &(dx, dy) in &offsets {
                let (xx, yy) = (x + dx, y + dy);
                if xx < 0 || yy < 0 || xx >= width as i64 || yy >= height as i64 {
                    continue;
                }
                let v = values[(yy * width as i64 + xx) as usize];
                if !v.is_nan() {
                    sum += v as f64;
                    n += 1;
                }
            }
            if n > 0 {
                out[centre] = (sum / n as f64) as f32;
            }
        }
    }
    out
}

/// Grey from VH_MIN (black) to VH_MAX (white); no value is transparent.
fn paint_grey(values: &[f32], warp: &render::Warp) -> Vec<u8> {
    render::paint_with(warp, |s| {
        let v = values[s];
        if v.is_nan() {
            return None;
        }
        let t = ((v as f64 - VH_MIN) / (VH_MAX - VH_MIN)).clamp(0.0, 1.0);
        let g = (t * 255.0).round() as u8;
        Some([g, g, g, 255])
    })
}

fn summary(scenes: &[RadarScene]) -> Vec<ObservationSummary> {
    scenes
        .iter()
        .map(|s| ObservationSummary { date: s.date.clone(), cloud_cover: 0.0, tiles: vec![format!("orbit {} {}", s.orbit, s.pass)], scenes: vec![s.id.clone()] })
        .collect()
}

struct FileRead {
    cog: Cog,
    level: usize,
    tiles_by_block: Vec<Vec<usize>>,
    last_use: HashMap<usize, usize>,
}

pub async fn run(client: &reqwest::Client, params: &RunParams, progress: &dyn Fn(&str, f64)) -> Result<(RunResult, Analysis), String> {
    let started = Instant::now();
    let mut stats = Stats::default();
    let traffic = Traffic::default();
    let label = params.period_name();
    let bounds = run::aoi_bounds(&params.aoi)?;

    progress("Searching the radar catalogue", 0.0);
    let (pre_all, post_all) = futures::try_join!(
        search(client, bounds, &params.pre_start, &params.pre_end),
        search(client, bounds, &params.post_start, &params.post_end)
    )?;
    if pre_all.is_empty() || post_all.is_empty() {
        return Err(format!(
            "{label}: Planetary Computer returned {} pre-period and {} post-period radar scenes. Widen the date window.",
            pre_all.len(),
            post_all.len()
        ));
    }
    let (orbits, pre_matched, post_matched) = same_orbits(&pre_all, &post_all);
    if orbits.is_empty() {
        let list = |s: &[RadarScene]| s.iter().map(|x| x.orbit).collect::<BTreeSet<_>>().iter().map(u32::to_string).collect::<Vec<_>>().join(", ");
        return Err(format!(
            "{label}: no relative orbit imaged the boundary in both windows (pre orbits {}, post orbits {}). Widen one window until an orbit appears in both.",
            list(&pre_all),
            list(&post_all)
        ));
    }
    let natural = grid::utm_epsg_for_lon_lat((bounds[0] + bounds[2]) / 2.0, (bounds[1] + bounds[3]) / 2.0);
    let both: Vec<RadarScene> = pre_matched.iter().chain(post_matched.iter()).cloned().collect();
    let epsg = best_epsg(&both, natural).unwrap_or(natural);
    let target = grid::grid_for_bounds(epsg, bounds, GRID_RESOLUTION)?;
    let pre: Vec<RadarScene> = pre_matched.into_iter().filter(|s| s.epsg == epsg).collect();
    let post: Vec<RadarScene> = post_matched.into_iter().filter(|s| s.epsg == epsg).collect();
    let dropped = pre_all.len() + post_all.len() - pre.len() - post.len();
    if pre.is_empty() || post.is_empty() {
        return Err(format!(
            "{label}: the matched radar scenes sit on another UTM zone than the working grid. Move or shrink the boundary away from the zone edge."
        ));
    }
    let passes: Vec<String> = pre.iter().chain(post.iter()).map(|s| s.pass.clone()).collect::<BTreeSet<_>>().into_iter().collect();
    let plural = |n: usize| if n == 1 { "" } else { "s" };
    let mut warnings = vec![format!(
        "{label}: relative orbit{} {} ({}), {} radar scene{} {} to {}, {} {} to {}.",
        plural(orbits.len()),
        orbits.iter().map(u32::to_string).collect::<Vec<_>>().join(", "),
        passes.join(", "),
        pre.len(),
        plural(pre.len()),
        params.pre_start,
        params.pre_end,
        post.len(),
        params.post_start,
        params.post_end
    )];
    if dropped > 0 {
        warnings.push(format!("{label}: {dropped} radar scene{} dropped, on an orbit seen in only one window or on another UTM zone.", plural(dropped)));
    }
    if pre.len() < MIN_SCENES || post.len() < MIN_SCENES {
        warnings.push(format!(
            "{label}: a window holds fewer than {MIN_SCENES} radar scenes, so its median rests on few looks and speckle will survive the smoothing. Widen the window if the dates allow."
        ));
    }
    warnings.push(format!(
        "{label}: the imagery is Planetary Computer's terrain-flattened RTC product rather than the GRD the breaks were calibrated on, and water is masked where VH falls below {WATER_FLOOR_DB} dB in either window rather than from JRC Global Surface Water."
    ));

    progress("Fetching the radar read token", 0.01);
    let token = read_token(client).await?;
    stats.search_s = started.elapsed().as_secs_f64();

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

    // Headers, and which tiles each block needs from each file.
    let urls: Vec<String> = pre.iter().chain(post.iter()).map(|s| format!("{}?{}", s.vh_href, token)).collect();
    progress(&format!("Reading {} radar image headers", urls.len()), 0.02);
    let clock = Instant::now();
    let opened: Vec<Result<Cog, String>> = stream::iter(urls.iter()).map(|url| cog::open(client, url, &traffic)).buffered(params.concurrency).collect().await;
    let mut files = Vec::with_capacity(opened.len());
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

    let total = (target.width * target.height) as usize;
    let mut pre_db = vec![f32::NAN; total];
    let mut post_db = vec![f32::NAN; total];
    let mut cache: HashMap<(usize, usize), Vec<u8>> = HashMap::new();
    for (b, block) in blocks.iter().enumerate() {
        progress(
            &format!("Block {} of {}, reading {} radar scenes", b + 1, blocks.len(), files.len()),
            0.05 + 0.8 * b as f64 / blocks.len() as f64,
        );
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

        let clock = Instant::now();
        let mut stacks: [Vec<Vec<f32>>; 2] = [Vec::new(), Vec::new()];
        for (f, file) in files.iter().enumerate() {
            let mut decoded = HashMap::new();
            for &t in &file.tiles_by_block[b] {
                if let Some(bytes) = cache.get(&(f, t)) {
                    decoded.insert(t, cog::decode_tile_f32(&file.cog, file.level, bytes)?);
                }
            }
            let mut values = cog::sample_block_bilinear(&file.cog, file.level, block.bbox, block.width, block.height, &decoded);
            to_decibels(&mut values);
            stacks[if f < pre.len() { 0 } else { 1 }].push(values);
            for &t in &file.tiles_by_block[b] {
                if file.last_use.get(&t) == Some(&b) {
                    cache.remove(&(f, t));
                }
            }
        }
        stats.decode_s += clock.elapsed().as_secs_f64();
        let clock = Instant::now();
        let length = (block.width * block.height) as usize;
        run::scatter(&mut pre_db, &median_stack(&stacks[0], length), block, &target);
        run::scatter(&mut post_db, &median_stack(&stacks[1], length), block, &target);
        stats.method_s += clock.elapsed().as_secs_f64();
    }

    progress("Smoothing and classifying", 0.9);
    let clock = Instant::now();
    let radius = (SMOOTH_M / target.resolution).max(std::f64::consts::SQRT_2);
    let (w, h) = (target.width as usize, target.height as usize);
    let pre_smooth = focal_mean(&pre_db, w, h, radius);
    let post_smooth = focal_mean(&post_db, w, h, radius);
    let mut drop = vec![f32::NAN; total];
    let mut observed_pixels = 0u64;
    for i in 0..total {
        let (a, c) = (pre_smooth[i], post_smooth[i]);
        let outside = aoi_mask.as_ref().is_some_and(|m| m[i] == 0);
        let wet = (a as f64) < WATER_FLOOR_DB || (c as f64) < WATER_FLOOR_DB;
        if outside || wet || a.is_nan() || c.is_nan() {
            continue;
        }
        drop[i] = (a as f64 - c as f64) as f32;
        observed_pixels += 1;
    }
    let mut finite: Vec<f64> = drop.iter().filter(|v| !v.is_nan()).map(|&v| v as f64).collect();
    let shift = median_f64(&mut finite);
    let shift_db = if shift.is_nan() { 0.0 } else { shift };
    for v in drop.iter_mut() {
        *v = (*v as f64 - shift_db) as f32;
    }
    let mut histogram = Histogram::for_delta(DeltaId::DVh);
    histogram.accumulate(&drop);
    let warp = render::build_warp(&target, 2048)?;
    let analysis = Analysis {
        label: label.clone(),
        sensor: Sensor::Sentinel1,
        target,
        warp,
        deltas: vec![(DeltaId::DVh, drop)],
        histograms: vec![histogram],
        normalisation: vec![Normalisation { offset: shift_db, stable_share: 1.0, applicable: true, refusal: None, method: "median" }],
    };
    let classified = run::classify(&analysis, &params.breaks, false)?;
    stats.method_s += clock.elapsed().as_secs_f64();

    let clock = Instant::now();
    let mut layers = vec![
        Layer {
            key: "pre-vh".into(),
            name: "Before, radar VH".into(),
            bounds: analysis.warp.bounds,
            png: render::png(&paint_grey(&pre_smooth, &analysis.warp), analysis.warp.width, analysis.warp.height)?,
        },
        Layer {
            key: "post-vh".into(),
            name: "After, radar VH".into(),
            bounds: analysis.warp.bounds,
            png: render::png(&paint_grey(&post_smooth, &analysis.warp), analysis.warp.width, analysis.warp.height)?,
        },
    ];
    layers.extend(classified.layers);
    stats.draw_s = clock.elapsed().as_secs_f64();

    stats.bytes = traffic.bytes();
    stats.requests = traffic.requests();
    stats.total_s = started.elapsed().as_secs_f64();
    progress("Done", 1.0);
    let result = RunResult {
        label,
        sensor: Sensor::Sentinel1,
        host: "Microsoft Planetary Computer".into(),
        epsg,
        grid_width: analysis.target.width,
        grid_height: analysis.target.height,
        pre: summary(&pre),
        post: summary(&post),
        deltas: classified.deltas,
        layers,
        patches: classified.patches,
        observed_pixels,
        thin_pixels: 0,
        atmosphere: None,
        radar: Some(RadarReport { orbits, passes, pre_scenes: pre.len(), post_scenes: post.len(), dropped, shift_db }),
        warnings,
        diagnostics: classified.diagnostics,
        stats,
    };
    Ok((result, analysis))
}
