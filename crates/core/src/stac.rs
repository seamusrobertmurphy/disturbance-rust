//! Scene search on the two STAC catalogues a browser can read with no account.
//!
//! Ported from `src/stac/search.ts` in disturbance-checker-srm 0.14.3, which
//! searches Earth Search only. This version also searches Microsoft's Planetary
//! Computer, which labels the same scenes differently, so every scene is
//! translated into one `Scene` whichever catalogue it came from.
//!
//! Rust notes for this file.
//! An `enum` is a value that is exactly one of a fixed list, the way an R factor
//! has fixed levels. A `struct` is a named record with typed fields, like a
//! Python dataclass. `Result<T, String>` is either a value or an error message,
//! and the `?` after a call returns the error to the caller at once, much as an
//! uncaught Python exception would.

use std::collections::HashMap;

use serde_json::{Map, Value, json};

/// A STAC catalogue whose search and pixels answer anonymous browser requests,
/// as tested on 10 November 2026 (bench/results/2026-11-10-catalogue-access.txt).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Host {
    /// Element 84's Earth Search on AWS, the checker's own source.
    EarthSearch,
    /// Microsoft's Planetary Computer, which signs pixel links with a free token.
    PlanetaryComputer,
}

/// The bands the checker reads.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Band {
    Blue,
    Green,
    Red,
    Nir,
    Nir08,
    Swir16,
    Swir22,
    Scl,
    Aot,
    Wvp,
}

impl Band {
    /// Every band of a scene, in the checker's order.
    pub const ALL: [Band; 10] = [
        Band::Blue,
        Band::Green,
        Band::Red,
        Band::Nir,
        Band::Nir08,
        Band::Swir16,
        Band::Swir22,
        Band::Scl,
        Band::Aot,
        Band::Wvp,
    ];

    /// A scene missing any of these is discarded, as in the checker's
    /// `REQUIRED_ASSETS`. AOT and WVP are optional there and here.
    pub fn required(self) -> bool {
        !matches!(self, Band::Aot | Band::Wvp)
    }

    /// The ESA band name, B04 and so on, as the SOP writes it.
    pub fn esa_name(self) -> &'static str {
        match self {
            Band::Blue => "B02",
            Band::Green => "B03",
            Band::Red => "B04",
            Band::Nir => "B08",
            Band::Nir08 => "B8A",
            Band::Swir16 => "B11",
            Band::Swir22 => "B12",
            Band::Scl => "SCL",
            Band::Aot => "AOT",
            Band::Wvp => "WVP",
        }
    }
}

/// Collection id of Sentinel-2 Level-2A on both hosts.
pub const S2_L2A: &str = "sentinel-2-l2a";

impl Host {
    pub fn name(self) -> &'static str {
        match self {
            Host::EarthSearch => "Earth Search",
            Host::PlanetaryComputer => "Planetary Computer",
        }
    }

    pub fn search_url(self) -> &'static str {
        match self {
            Host::EarthSearch => "https://earth-search.aws.element84.com/v1/search",
            Host::PlanetaryComputer => "https://planetarycomputer.microsoft.com/api/stac/v1/search",
        }
    }

    /// The asset key this host uses for a band. Earth Search uses common
    /// names such as `red`; Planetary Computer uses ESA names such as `B04`.
    pub fn asset_key(self, band: Band) -> &'static str {
        match self {
            Host::PlanetaryComputer => band.esa_name(),
            Host::EarthSearch => match band {
                Band::Blue => "blue",
                Band::Green => "green",
                Band::Red => "red",
                Band::Nir => "nir",
                Band::Nir08 => "nir08",
                Band::Swir16 => "swir16",
                Band::Swir22 => "swir22",
                Band::Scl => "scl",
                Band::Aot => "aot",
                Band::Wvp => "wvp",
            },
        }
    }
}

/// One Sentinel-2 product, described the same way whichever host listed it.
#[derive(Clone, Debug)]
pub struct Scene {
    pub host: Host,
    pub id: String,
    /// Acquisition instant as the host gives it. The two hosts differ by a few
    /// minutes for one scene: Earth Search gives the tile's sensing time and
    /// Planetary Computer the datatake's start.
    pub datetime: String,
    /// Calendar date in UTC, used to merge duplicates.
    pub date: String,
    pub cloud_cover: f64,
    /// UTM zone code of every asset, such as 32610.
    pub epsg: u32,
    /// MGRS tile, such as 10TEP.
    pub tile: String,
    /// Lower case, because the hosts disagree on capitals.
    pub platform: String,
    /// Processing time. Earth Search gives it; Planetary Computer does not.
    pub created: String,
    /// ESA processing baseline, such as 5.11.
    pub baseline: f64,
    /// The overpass this product was cut from, without the baseline suffix.
    pub datatake: String,
    /// Whether the +1000 DN offset has been removed already. Only Earth Search
    /// reports this, as `earthsearch:boa_offset_applied`. Planetary Computer
    /// serves ESA's products unaltered, so its baseline 4 and later scenes
    /// still carry the offset.
    pub boa_offset_applied: bool,
    pub hrefs: HashMap<Band, String>,
}

/// Baseline from which ESA adds the +1000 DN offset.
pub const BOA_OFFSET_BASELINE: f64 = 4.0;
/// The offset in DN.
pub const BOA_OFFSET_DN: f64 = 1000.0;

impl Scene {
    /// DN to subtract from every reflectance band before dividing by 10,000,
    /// the checker's `boaOffsetCorrection`.
    pub fn boa_offset_correction(&self) -> f64 {
        if self.boa_offset_applied {
            0.0
        } else if self.baseline >= BOA_OFFSET_BASELINE {
            BOA_OFFSET_DN
        } else {
            0.0
        }
    }
}

pub struct SearchParams {
    /// West, south, east, north in degrees.
    pub bbox: [f64; 4],
    /// Inclusive start, a date such as 2024-08-01.
    pub start: String,
    /// Exclusive end.
    pub end: String,
    /// Scene cloud ceiling in per cent; 100 turns it off.
    pub max_cloud: f64,
}

const PAGE_SIZE: u32 = 100;
const MAX_PAGES: u32 = 20;

/// A date alone is widened to midnight UTC, which Earth Search requires.
fn to_rfc3339(value: &str) -> String {
    if value.contains(':') {
        value.to_string()
    } else {
        format!("{value}T00:00:00Z")
    }
}

/// Remove a trailing baseline suffix such as `_N05.11`, the checker's
/// regular expression `/_N\d+\.\d+$/`.
fn strip_baseline(datatake: &str) -> &str {
    if let Some(i) = datatake.rfind("_N") {
        let rest = &datatake[i + 2..];
        let mut parts = rest.split('.');
        let digits = |p: Option<&str>| p.is_some_and(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()));
        if digits(parts.next()) && digits(parts.next()) && parts.next().is_none() {
            return &datatake[..i];
        }
    }
    datatake
}

fn text(props: &Map<String, Value>, key: &str) -> String {
    match props.get(key) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}

/// Read one STAC item into a `Scene`, or `None` if it lacks a required band
/// as an https link. An `s3://` link is on a requester-pays bucket that a
/// browser cannot read.
fn parse_item(host: Host, item: &stac::Item) -> Option<Scene> {
    let props = &item.properties.additional_fields;
    let epsg = props.get("proj:epsg").and_then(Value::as_u64)? as u32;
    let datetime = item.properties.datetime?.to_rfc3339();

    let mut hrefs = HashMap::new();
    for band in Band::ALL {
        let href = item.assets.get(host.asset_key(band)).map(|a| a.href.clone());
        match href {
            Some(h) if h.starts_with("https://") => {
                hrefs.insert(band, h);
            }
            _ if band.required() => return None,
            _ => {}
        }
    }

    let tile = match host {
        Host::EarthSearch => text(props, "grid:code").trim_start_matches("MGRS-").to_string(),
        Host::PlanetaryComputer => text(props, "s2:mgrs_tile"),
    };
    let datatake_raw = text(props, "s2:datatake_id");
    let datatake = if datatake_raw.is_empty() {
        item.id.clone()
    } else {
        strip_baseline(&datatake_raw).to_string()
    };

    Some(Scene {
        host,
        id: item.id.clone(),
        date: datetime[..10].to_string(),
        datetime,
        cloud_cover: props.get("eo:cloud_cover").and_then(Value::as_f64).unwrap_or(100.0),
        epsg,
        tile,
        platform: text(props, "platform").to_lowercase(),
        created: item.properties.created.clone().unwrap_or_default(),
        baseline: text(props, "s2:processing_baseline").parse().unwrap_or(0.0),
        datatake,
        boa_offset_applied: props.get("earthsearch:boa_offset_applied") == Some(&Value::Bool(true)),
        hrefs,
    })
}

/// Keep one product per tile, day and satellite: the higher baseline, then
/// the later processing time. The checker's `deduplicate`.
fn deduplicate(scenes: Vec<Scene>) -> Vec<Scene> {
    let mut best: HashMap<String, Scene> = HashMap::new();
    for scene in scenes {
        let key = format!("{}|{}|{}", scene.tile, scene.date, scene.platform);
        let better = match best.get(&key) {
            None => true,
            Some(held) if scene.baseline != held.baseline => scene.baseline > held.baseline,
            Some(held) => scene.created > held.created,
        };
        if better {
            best.insert(key, scene);
        }
    }
    let mut kept: Vec<Scene> = best.into_values().collect();
    kept.sort_by(|a, b| a.datetime.cmp(&b.datetime));
    kept
}

/// Search one host for Sentinel-2 L2A scenes, following every page.
///
/// `client: &reqwest::Client` is a borrow, Rust's word for lending a value
/// without handing it over. The caller keeps its client and can lend it again,
/// much as an R function reads an argument without consuming it.
pub async fn search(
    client: &reqwest::Client,
    host: Host,
    params: &SearchParams,
) -> Result<Vec<Scene>, String> {
    let mut body = json!({
        "collections": [S2_L2A],
        "bbox": params.bbox,
        "datetime": format!("{}/{}", to_rfc3339(&params.start), to_rfc3339(&params.end)),
        "limit": PAGE_SIZE,
    });
    if params.max_cloud < 100.0 {
        body["query"] = json!({ "eo:cloud_cover": { "lt": params.max_cloud } });
    }

    let mut url = host.search_url().to_string();
    let mut collected = Vec::new();
    for _ in 0..MAX_PAGES {
        let response = client
            .post(&url)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("{} search failed: {e}", host.name()))?;
        if !response.status().is_success() {
            return Err(format!("{} search returned {}", host.name(), response.status()));
        }
        let page: stac::ItemCollection = response
            .json()
            .await
            .map_err(|e| format!("{} sent a page that is not a STAC item collection: {e}", host.name()))?;
        collected.extend(page.items.iter().filter_map(|item| parse_item(host, item)));

        // The next page is a POST link that carries its own body.
        match page.links.iter().find(|l| l.rel == "next") {
            Some(next) if next.body.is_some() => {
                url = next.href.clone();
                body = Value::Object(next.body.clone().unwrap_or_default());
            }
            _ => break,
        }
    }
    Ok(deduplicate(collected))
}

/// Planetary Computer's free read token for Sentinel-2 L2A.
///
/// The token is anonymous and lasts about an hour. It comes from
/// https://planetarycomputer.microsoft.com/api/sas/v1/token/sentinel-2-l2a
/// Ask for it once per run: the service limits how often it is asked.
pub async fn planetary_computer_token(client: &reqwest::Client) -> Result<String, String> {
    let url = format!("https://planetarycomputer.microsoft.com/api/sas/v1/token/{S2_L2A}");
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Planetary Computer token request failed: {e}"))?;
    let status = response.status();
    let reply: Value = response
        .json()
        .await
        .map_err(|e| format!("Planetary Computer token reply {status} unreadable: {e}"))?;
    reply
        .get("token")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or(format!("Planetary Computer token reply {status} has no token: {reply}"))
}

/// Append the token to every pixel link of the Planetary Computer scenes.
pub fn sign(scenes: &mut [Scene], token: &str) {
    for scene in scenes.iter_mut().filter(|s| s.host == Host::PlanetaryComputer) {
        for href in scene.hrefs.values_mut() {
            *href = format!("{href}?{token}");
        }
    }
}

/// One overpass: every tile of one datatake on the working grid.
#[derive(Clone, Debug)]
pub struct Observation {
    pub datatake: String,
    pub datetime: String,
    /// Worst cloud cover among its tiles.
    pub cloud_cover: f64,
    pub scenes: Vec<Scene>,
}

/// Fold scenes into observations on one UTM zone, the checker's
/// `observationsOnGrid`. Overpasses with no tile in that zone are dropped here;
/// the checker reports them as unreachable.
pub fn observations_on_grid(scenes: &[Scene], epsg: u32) -> Vec<Observation> {
    let mut order: Vec<String> = Vec::new();
    let mut by_datatake: HashMap<String, Vec<Scene>> = HashMap::new();
    for scene in scenes {
        if !by_datatake.contains_key(&scene.datatake) {
            order.push(scene.datatake.clone());
        }
        by_datatake.entry(scene.datatake.clone()).or_default().push(scene.clone());
    }
    let mut observations: Vec<Observation> = order
        .into_iter()
        .filter_map(|datatake| {
            let on_grid: Vec<Scene> = by_datatake[&datatake]
                .iter()
                .filter(|s| s.epsg == epsg)
                .cloned()
                .collect();
            let first = on_grid.first()?;
            Some(Observation {
                datetime: first.datetime.clone(),
                cloud_cover: on_grid.iter().map(|s| s.cloud_cover).fold(f64::MIN, f64::max),
                datatake,
                scenes: on_grid,
            })
        })
        .collect();
    observations.sort_by(|a, b| a.datetime.cmp(&b.datetime));
    observations
}

/// The UTM zone that reaches the most overpasses, ties going to `preferred`,
/// the checker's `bestEpsgFor`.
pub fn best_epsg_for(scenes: &[Scene], preferred: u32) -> Option<u32> {
    // Zones in the order the catalogue first lists them, as the checker's Map does.
    let mut zones: Vec<u32> = Vec::new();
    for scene in scenes {
        if !zones.contains(&scene.epsg) {
            zones.push(scene.epsg);
        }
    }
    let mut winner = None;
    let mut best = -1i64;
    for epsg in zones {
        let reachable = observations_on_grid(scenes, epsg).len() as i64;
        if reachable > best || (reachable == best && epsg == preferred) {
            best = reachable;
            winner = Some(epsg);
        }
    }
    winner
}
