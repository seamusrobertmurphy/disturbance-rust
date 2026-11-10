//! `disturbance`, the terminal front end to disturbance-core.
//!
//! One command so far, `bytes`. It searches Earth Search and Planetary
//! Computer for the scenes the checker would use on a square test area, reads
//! only the image headers, and reports how many bytes the pixel reads cost.
//! It compares geotiff.js's choice of resolution with reading every band at
//! 20 m. No pixels are downloaded.
//!
//!   cargo run --release -p disturbance-cli -- bytes --ha 25600
//!
//! Rust notes for this file.
//! `async fn` and `.await` work as in Python's asyncio: a download is started,
//! and the program does other work until the bytes arrive. Tokio is the
//! runtime that runs them, the counterpart of `asyncio.run`. A closure such as
//! `|o| o.cloud_cover` is an unnamed function, like `function(o) o$cloud_cover`
//! in R or `lambda o: o.cloud_cover` in Python.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Instant;

use disturbance_core::cog::{self, Cog, Traffic};
use disturbance_core::grid::{self, BLOCK_SIZE, GRID_RESOLUTION};
use disturbance_core::stac::{self, Band, Host, Observation, SearchParams};
use futures::stream::{self, StreamExt};

/// Simultaneous header reads, the checker's `READ_CONCURRENCY`.
const CONCURRENCY: usize = 12;
/// Observations per window whose blue, green, AOT and WVP the checker reads,
/// its `RGB_OBSERVATION_COUNT`.
const RGB_OBSERVATION_COUNT: usize = 3;
/// Bands read for every observation with the SCL mask: the five index bands
/// and SCL, the checker's `assetsFor("scl")`.
const ANALYSIS_BANDS: [Band; 6] = [Band::Red, Band::Nir, Band::Nir08, Band::Swir16, Band::Swir22, Band::Scl];
/// Bands read only for the RGB subset, its `RGB_EXTRA_BANDS` and `ATMOSPHERE_BANDS`.
const EXTRA_BANDS: [Band; 4] = [Band::Blue, Band::Green, Band::Aot, Band::Wvp];

struct Args {
    hosts: Vec<Host>,
    ha: f64,
    lat: f64,
    lon: f64,
    pre: (String, String),
    post: (String, String),
    max_cloud: f64,
}

fn usage() -> ! {
    eprintln!(
        "usage: disturbance bytes [--host earth-search|planetary-computer|both] [--ha 1600] \
         [--lat 44.0] [--lon -122.5] [--pre 2024-08-01/2024-09-01] [--post 2025-08-01/2025-09-01] [--max-cloud 30]"
    );
    std::process::exit(2)
}

fn parse_args() -> Args {
    let mut args = Args {
        hosts: vec![Host::EarthSearch, Host::PlanetaryComputer],
        ha: 1600.0,
        lat: 44.0,
        lon: -122.5,
        pre: ("2024-08-01".into(), "2024-09-01".into()),
        post: ("2025-08-01".into(), "2025-09-01".into()),
        max_cloud: 30.0,
    };
    let raw: Vec<String> = std::env::args().skip(1).collect();
    if raw.first().map(String::as_str) != Some("bytes") {
        usage();
    }
    let window = |v: &str| match v.split_once('/') {
        Some((a, b)) => (a.to_string(), b.to_string()),
        None => usage(),
    };
    let mut i = 1;
    while i < raw.len() {
        let value = raw.get(i + 1).cloned().unwrap_or_else(|| usage());
        let number = || value.parse::<f64>().unwrap_or_else(|_| usage());
        match raw[i].as_str() {
            "--host" => {
                args.hosts = match value.as_str() {
                    "earth-search" => vec![Host::EarthSearch],
                    "planetary-computer" => vec![Host::PlanetaryComputer],
                    "both" => vec![Host::EarthSearch, Host::PlanetaryComputer],
                    _ => usage(),
                }
            }
            "--ha" => args.ha = number(),
            "--lat" => args.lat = number(),
            "--lon" => args.lon = number(),
            "--max-cloud" => args.max_cloud = number(),
            "--pre" => args.pre = window(&value),
            "--post" => args.post = window(&value),
            _ => usage(),
        }
        i += 2;
    }
    args
}

/// A square of the given area centred on a point, in degrees as west, south,
/// east, north. The same square as bench/checker-timing.ts.
fn square(lat: f64, lon: f64, ha: f64) -> [f64; 4] {
    let side = ha.sqrt() * 100.0;
    let d_lat = side / 111_132.0 / 2.0;
    let d_lon = side / (111_320.0 * lat.to_radians().cos()) / 2.0;
    [lon - d_lon, lat - d_lat, lon + d_lon, lat + d_lat]
}

/// The checker's `rgbSubsetOf`: the three least cloudy observations, ties in
/// date order because JavaScript's sort is stable.
fn rgb_subset(observations: &[Observation]) -> BTreeSet<usize> {
    let mut order: Vec<usize> = (0..observations.len()).collect();
    order.sort_by(|&a, &b| observations[a].cloud_cover.total_cmp(&observations[b].cloud_cover));
    order.into_iter().take(RGB_OBSERVATION_COUNT).collect()
}

/// One band of one scene that the checker reads.
struct Read {
    band: Band,
    url: String,
}

fn reads_for(observations: &[Observation]) -> Vec<Read> {
    let subset = rgb_subset(observations);
    let mut reads = Vec::new();
    for (i, observation) in observations.iter().enumerate() {
        let bands = ANALYSIS_BANDS
            .iter()
            .chain(if subset.contains(&i) { EXTRA_BANDS.iter() } else { [].iter() });
        for &band in bands {
            for scene in &observation.scenes {
                if let Some(url) = scene.hrefs.get(&band) {
                    reads.push(Read { band, url: url.clone() });
                }
            }
        }
    }
    reads
}

/// Totals for one band across every file read.
#[derive(Default)]
struct Tally {
    files: usize,
    native: f64,
    /// Tile sizes seen across the files, which can differ between scenes.
    tiles: BTreeSet<(u32, u32)>,
    compression: String,
    /// Tiles at the level geotiff.js picks, each fetched once per run.
    js_unique: u64,
    /// The same, widened to geotiff.js's 64 KiB blocks.
    js_blocks: u64,
    /// The same tiles counted again for every 512 pixel block that touches them.
    js_per_block: u64,
    /// Tiles at the 20 m level, each fetched once per run.
    at_20m: u64,
    /// The pixels the method uses, uncompressed.
    raw: u64,
}

fn mb(bytes: u64) -> String {
    format!("{:.1}", bytes as f64 / 1e6)
}

async fn run_host(client: &reqwest::Client, host: Host, args: &Args) -> Result<(), String> {
    let bbox = square(args.lat, args.lon, args.ha);
    let params = |w: &(String, String)| SearchParams {
        bbox,
        start: w.0.clone(),
        end: w.1.clone(),
        max_cloud: args.max_cloud,
    };

    // Named first, so both searches can borrow them for as long as they run.
    let (pre_params, post_params) = (params(&args.pre), params(&args.post));
    let clock = Instant::now();
    let (mut pre_all, mut post_all) = futures::try_join!(
        stac::search(client, host, &pre_params),
        stac::search(client, host, &post_params),
    )?;
    let search_seconds = clock.elapsed().as_secs_f64();
    if host == Host::PlanetaryComputer {
        let token = stac::planetary_computer_token(client).await?;
        stac::sign(&mut pre_all, &token);
        stac::sign(&mut post_all, &token);
    }

    let natural = grid::utm_epsg_for_lon_lat((bbox[0] + bbox[2]) / 2.0, (bbox[1] + bbox[3]) / 2.0);
    let all: Vec<_> = pre_all.iter().chain(post_all.iter()).cloned().collect();
    let epsg = stac::best_epsg_for(&all, natural).unwrap_or(natural);
    let target = grid::grid_for_bounds(epsg, bbox, GRID_RESOLUTION)?;
    let blocks = grid::blocks_for(&target, BLOCK_SIZE);

    let pre = stac::observations_on_grid(&pre_all, epsg);
    let post = stac::observations_on_grid(&post_all, epsg);
    let offsets: BTreeSet<String> = pre
        .iter()
        .chain(post.iter())
        .flat_map(|o| o.scenes.iter())
        .map(|s| format!("{}", s.boa_offset_correction()))
        .collect();

    let reads: Vec<Read> = reads_for(&pre).into_iter().chain(reads_for(&post)).collect();

    // Headers, twelve at a time.
    let traffic = Arc::new(Traffic::default());
    let clock = Instant::now();
    let urls: BTreeSet<String> = reads.iter().map(|r| r.url.clone()).collect();
    let opened: Vec<Result<Cog, String>> = stream::iter(urls)
        .map(|url| {
            let traffic = traffic.clone();
            async move { cog::open(client, &url, traffic).await }
        })
        .buffer_unordered(CONCURRENCY)
        .collect()
        .await;
    let header_seconds = clock.elapsed().as_secs_f64();
    let mut cogs: HashMap<String, Cog> = HashMap::new();
    for result in opened {
        let c = result?;
        cogs.insert(c.url.clone(), c);
    }

    let mut tallies: BTreeMap<Band, Tally> = BTreeMap::new();
    for read in &reads {
        let c = &cogs[&read.url];
        let t = tallies.entry(read.band).or_default();
        let js = c.level_geotiff_js(GRID_RESOLUTION);
        let l20 = c.level_at_most(GRID_RESOLUTION);
        let mut js_tiles = BTreeSet::new();
        let mut tiles_20 = BTreeSet::new();
        for block in &blocks {
            let these: BTreeSet<usize> = c.window_tiles(js, block.bbox).into_iter().collect();
            t.js_per_block += c.tile_bytes(js, &these);
            js_tiles.extend(these);
            tiles_20.extend(c.window_tiles(l20, block.bbox));
        }
        t.files += 1;
        t.native = c.levels[0].resolution;
        t.tiles.insert((c.levels[js].tile_width, c.levels[js].tile_height));
        t.compression = c.levels[0].compression.clone();
        t.js_unique += c.tile_bytes(js, &js_tiles);
        t.js_blocks += c.block_rounded_bytes(js, &js_tiles, 65_536);
        t.at_20m += c.tile_bytes(l20, &tiles_20);
        let bytes_per_pixel = if read.band == Band::Scl { 1 } else { 2 };
        t.raw += target.width as u64 * target.height as u64 * bytes_per_pixel;
    }

    println!("{}, {} ha square at {}, {}", host.name(), args.ha, args.lat, args.lon);
    println!(
        "  grid EPSG:{epsg} {} x {} px at 20 m, {} blocks; observations {}+{}; band reads {}; DN offsets subtracted {:?}",
        target.width,
        target.height,
        blocks.len(),
        pre.len(),
        post.len(),
        reads.len(),
        offsets
    );
    println!(
        "  search {search_seconds:.2} s; headers {header_seconds:.2} s, {} files, {} requests, {} MB",
        cogs.len(),
        traffic.requests.load(Ordering::Relaxed),
        mb(traffic.bytes.load(Ordering::Relaxed))
    );
    println!("  band  files native tile       compression  geotiff.js MB: once | 64 KiB blocks | per block   20 m MB  uncompressed MB");
    let mut total = Tally::default();
    for (band, t) in &tallies {
        println!(
            "  {:<5} {:>5} {:>4.0} m {:<10} {:<12} {:>10} | {:>13} | {:>9}   {:>7}  {:>9}",
            band.esa_name(),
            t.files,
            t.native,
            t.tiles.iter().map(|(w, _)| w.to_string()).collect::<Vec<_>>().join(","),
            t.compression,
            mb(t.js_unique),
            mb(t.js_blocks),
            mb(t.js_per_block),
            mb(t.at_20m),
            mb(t.raw)
        );
        total.files += t.files;
        total.js_unique += t.js_unique;
        total.js_blocks += t.js_blocks;
        total.js_per_block += t.js_per_block;
        total.at_20m += t.at_20m;
        total.raw += t.raw;
    }
    println!(
        "  total {:>5}                                 {:>10} | {:>13} | {:>9}   {:>7}  {:>9}",
        total.files,
        mb(total.js_unique),
        mb(total.js_blocks),
        mb(total.js_per_block),
        mb(total.at_20m),
        mb(total.raw)
    );
    Ok(())
}

#[tokio::main]
async fn main() {
    let args = parse_args();
    let client = reqwest::Client::builder()
        .user_agent("disturbance-rust/0.1")
        .build()
        .expect("HTTP client");
    for &host in &args.hosts {
        if let Err(e) = run_host(&client, host, &args).await {
            eprintln!("{}: {e}", host.name());
        }
    }
}
