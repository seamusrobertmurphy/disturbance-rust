# Canopy disturbance check

This tool flags where Sentinel-2 satellite images show a drop in forest canopy between two summers. It follows the SOP "Canopy Disturbance Checks for ACR IFM Verification". It runs in a web browser, with nothing to install and no account.

Open <https://seamusrobertmurphy.github.io/disturbance-rust/> in Chrome, Edge, Firefox or Safari.

## Using it

1. Give the project boundary. Draw a rectangle or a polygon on the map, or upload a GeoJSON, KML or zipped shapefile.
2. Pick the two date windows. The SOP uses 1 August to 1 September of each year.
3. Press Run the check. A project of a few thousand hectares takes under a minute on a good connection.

Your boundary never leaves your computer. The browser downloads the satellite images itself and does every calculation on your machine.

## Reading results

The map shows three layers, each in low, moderate and high classes.

1. dNDVI shows a loss of canopy greenness.
2. dNDMI shows a loss of canopy moisture, which often comes before visible loss.
3. dNBR shows burning.

The true-colour pictures of each window sit underneath, so a flagged patch can be checked by eye.

The table lists each flagged patch, a group of touching pixels classed moderate or high. Each row gives the index, the class, the patch's centre and its strongest value. Click a row to zoom to the patch. The table can be downloaded as a CSV file.

The tool gives no areas. A flagged patch is a change in reflected light, and until it has been checked on the ground it is not known to be a loss of canopy. Report the index, the class, the location and the dates instead.

## The method

For each window, the tool finds every Sentinel-2 Level-2A scene with less than 30 per cent cloud. It drops cloud, cloud shadow, terrain shadow and snow pixels using the scene classification that ESA ships with each scene. It then takes the middle value of each 20 m pixel across the clear views, so a single bad view cannot sway the result.

From those values it computes NDVI from bands 8 and 4, NDMI from bands 8 and 11, and NBR from bands 8A and 12. It classes the change in each index at the SOP's thresholds.

| Index | Low | Moderate | High |
|---|---|---|---|
| dNDVI | 0.10 | 0.20 | 0.35 |
| dNDMI | 0.15 | 0.30 | 0.45 |
| dNBR | 0.10 | 0.27 | 0.44 |

Pixels that were water in either window are left out. A window with fewer than four clear views raises a warning, because the SOP treats four as the minimum for a stable result.

One step goes beyond the SOP and can be switched off under Settings. If a dry summer moves all the unchanged forest by the same amount, the thresholds move by that amount too. It applies only when at least half of the pixels sit within 0.05 of the unchanged peak.

## Image sources

The images come from two public catalogues that answer a browser with no account. Both use STAC, the common standard for searching satellite image collections.

1. Earth Search, run by Element 84 on Amazon Web Services. This is the default and the disturbance checker's own source.
2. Microsoft Planetary Computer. Its files are cut into smaller pieces, so small projects download less.

From January 2022, ESA added 1,000 to every Level-2A pixel value. Earth Search removes it before publishing, and the tool removes it from Planetary Computer scenes itself.

## Speed

The method is a line-by-line port of the disturbance checker, version 0.14.3, written in Rust. On two square test areas near 44.0 N, 122.5 W, comparing August 2024 with August 2025, it put every pixel in the same class as the checker. It ran in less time, as the table below shows.

| Test square | Checker | Rust, terminal | Rust, browser |
|---|---|---|---|
| 1,600 ha | 19.2 s, 147 MB | 13.7 s, 149 MB | 15.6 s, 149 MB |
| 25,600 ha | 96.2 s, 830 MB | 42.6 s, 409 MB | 33.0 s, 409 MB |

The browser ran the larger square straight after the smaller one, over the same scenes, so some of its bytes may have come from the browser's cache. Its 33.0 s is a best case.

Most of the gain comes from downloading less. The checker downloads an image tile again for each 512 by 512 pixel block of the project, while this tool downloads each tile once. The checker's times were measured by running its own code in Node with a browser's limit of six connections per server, on 10 November 2026. Download times depend on the connection.

## For developers

The repository is a Cargo workspace of three crates. `crates/core` holds the method, `crates/cli` a terminal program and `crates/web` the bridge to the browser. The page is in `site/`.

```sh
# The check in the terminal, writing map layers, the table and a JSON summary
cargo run --release -p disturbance-cli -- run --geojson boundary.geojson --out results

# The browser build, then a local server at http://localhost:8765
wasm-pack build crates/web --target web --out-dir ../../site/pkg --release --no-pack
python3 -m http.server 8765 --directory site
```

`bench/` holds the scripts and dated results behind the comparisons above.
