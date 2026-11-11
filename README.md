# Canopy disturbance check

This tool flags where satellite images show a drop in forest canopy between two dates. It follows the SOP "Canopy Disturbance Checks for ACR IFM Verification". It runs in a web browser, with nothing to install and no account.

Open <https://seamusrobertmurphy.github.io/disturbance-rust/> in Chrome, Edge, Firefox or Safari.

## Using it

1. Choose the imagery. Sentinel-2 optical is the SOP's check. Sentinel-1 radar sees through cloud and snow, so it suits a harvest made in winter on frozen ground.
2. Give the project boundary. Draw a rectangle or a polygon, upload a GeoJSON, KML or zipped shapefile, or pick a parcel from the statewide parcel maps of 21 states.
3. Pick the date windows. The SOP uses 1 August to 1 September of each year. For radar, put both windows in the same part of winter, such as 5 December to 4 February. Add a reporting period to check several at once.
4. Check the thresholds. They start at the SOP's values. Moving one marks the index as adjusted and asks for a reason, which goes into the run record.
5. Load any site data. Streamside management zones, plot points and the developer's reported harvest are optional, and are drawn over the results.
6. Press Run the check. Most of the wait is spent downloading the images, so the time depends on the connection. On 10 November 2026, a 1,600 ha square took 16 seconds and a 530 ha box took 60 seconds, because its images downloaded more slowly.

Season at the site, under the dates, draws the daily temperature, sunlight, rain and snow at the site from NASA POWER, with the windows shaded. It shows whether the two windows fall at the same point of the season. It is not used in the check.

Your boundary file is never uploaded. The browser downloads the satellite images itself and does every calculation on your machine. Only the box around the boundary is sent, to the image catalogues and to the registries under Corroboration when you ask for them. The season charts send the boundary's centre to NASA POWER, and the parcel picker sends the point you click to that state's parcel service.

## Reading results

The optical check draws three layers, each in low, moderate and high classes.

1. dNDVI shows a loss of canopy greenness.
2. dNDMI shows a loss of canopy moisture, which often comes before visible loss.
3. dNBR shows burning.

The radar check draws one, dVH, the drop in the radar signal returned by branches and stems. Each run also keeps its before and after pictures underneath, in true colour for the optical check and in grey for radar, so a flagged patch can be checked by eye.

Each index has a histogram of every pixel's change, with its three thresholds drawn as coloured lines. Dragging a line redraws the map, the table and the run record without downloading anything again. On the 530 ha box this took a third of a second. The checker downloads the images again for this.

The panel runs the SOP's checks on every run. It warns when a window falls outside July to September, when the two windows cover different months, and when a window has fewer than four clear views. It also reads the shape of each histogram. A long tail with no gap points to a contaminated composite rather than disturbance, and a clear gap gets a suggested Low threshold, drawn as a dashed green line.

The table lists each flagged patch, a group of touching pixels classed moderate or high. Each row gives the index, the class, the patch's centre and its strongest value. Click a row to zoom to the patch. The table can be downloaded as a CSV file.

The visual check shows Esri's World Imagery Wayback, a dated archive of pictures often sharper than a metre. Each release lists when its picture was taken at the chosen point, often a year or more before the release, and that capture date is the one to cite.

Corroboration loads records that other people made from other data, none of which is used in the check. They are mapped fire, LCMS change, the LANDFIRE disturbance agent, insect and disease records, and the Forest Service's FACTS record of management. Agreement with an unrelated record carries more weight than either alone.

The run record lists every setting, threshold, reason, check and source of the run. Copy it or download it to keep with a finding.

The tool gives no areas. A flagged patch is a change in reflected light or radar signal, and until it has been checked on the ground it is not known to be a loss of canopy. Report the index, the class, the location and the dates instead.

## The method

For each optical window, the tool finds every Sentinel-2 Level-2A scene with less than 30 per cent cloud. It drops cloud, cloud shadow, terrain shadow and snow pixels using the scene classification that ESA ships with each scene. It then takes the middle value of each 20 m pixel across the clear views, so a single bad view cannot sway the result.

From those values it computes NDVI from bands 8 and 4, NDMI from bands 8 and 11, and NBR from bands 8A and 12. It classes the change in each index at the SOP's thresholds.

| Index | Low | Moderate | High |
|---|---|---|---|
| dNDVI | 0.10 | 0.20 | 0.35 |
| dNDMI | 0.15 | 0.30 | 0.45 |
| dNBR | 0.10 | 0.27 | 0.44 |
| dVH | 2.0 dB | 2.5 dB | 3.5 dB |

Pixels that were water in either window are left out. A window with fewer than four clear views raises a warning, because the SOP treats four as the minimum for a stable result.

One step goes beyond the SOP and can be switched off under Settings. If a dry summer moves all the unchanged forest by the same amount, the thresholds move by that amount too. It applies only when at least half of the pixels sit within 0.05 of the unchanged peak.

Settings also offer a faster download, off by default. Bands 2, 3, 4 and 8 are stored at 10 m, and each image file also keeps a 20 m copy of them. Reading that copy cut the download on the 1,600 ha test square from 148.5 MB to 77.9 MB. Each 20 m value is the average of four 10 m pixels, so fewer pixels reached the moderate class, 44 against 75 on dNDVI. dNBR uses only 20 m bands and did not change.

The radar check finds every Sentinel-1 scene over the boundary in each window. It keeps only the satellite tracks seen in both windows, so each pixel is compared with itself seen from the same side. It takes each window's middle value of the VH signal in decibels, and averages each pixel with its eight neighbours to quiet the speckle every radar image carries. The drop from before to after is the change. The middle drop over the whole boundary is taken off every pixel, so a colder or wetter winter is not read as loss. Pixels below -22 dB in either window are taken as water and left out.

The radar thresholds come from the checker's own test against 878 clearcut blocks reported near Cochrane, Ontario. At the Low threshold, 43.9 per cent of test points inside those clearcuts were flagged, and 3.8 per cent of points away from any harvest. Radar therefore misses more than half of clearcut pixels and flags some uncut ground, so check a radar patch against the optical layers and the pictures before reporting it.

## Image sources

The images come from two public catalogues that answer a browser with no account. Both use STAC, the common standard for searching satellite image collections.

1. Earth Search, run by Element 84 on Amazon Web Services. This is the default optical source and the disturbance checker's own.
2. Microsoft Planetary Computer. It holds Sentinel-2 in smaller pieces, so small projects download less, and it is the radar source, with Sentinel-1 scenes already corrected for terrain.

From January 2022, ESA added 1,000 to every Level-2A pixel value. Earth Search removes it before publishing, and the tool removes it from Planetary Computer scenes itself.

The season comes from NASA POWER, the dated pictures from Esri's Wayback archive and parcels from each state's parcel service. The run record lists the corroboration registries.

## Speed

The method is a line-by-line port of the disturbance checker, version 0.14.3, written in Rust. On two square test areas near 44.0 N, 122.5 W, comparing August 2024 with August 2025, it put every pixel in the same class as the checker. It ran in less time, as the table below shows.

| Test square | Checker | Rust, terminal | Rust, browser |
|---|---|---|---|
| 1,600 ha | 19.2 s, 147 MB | 13.7 s, 149 MB | 15.6 s, 149 MB |
| 25,600 ha | 96.2 s, 830 MB | 42.6 s, 409 MB | 33.0 s, 409 MB |

The browser ran the larger square straight after the smaller one, over the same scenes, so some of its bytes may have come from the browser's cache. Its 33.0 s is a best case.

Most of the gain comes from downloading less. The checker downloads an image tile again for each 512 by 512 pixel block of the project, while this tool downloads each tile once. The checker's times were measured by running its own code in Node with a browser's limit of six connections per server, on 10 November 2026. Download times depend on the connection.

The radar check also put every pixel in the same class as the checker, on a 1,600 ha square near Cochrane, Ontario, comparing the winter of 2023 to 2024 with that of 2025 to 2026. Both took 37 to 39 seconds, nearly all of it downloading. That square is a single block, so the checker downloaded each tile only once there too.

## For developers

The repository is a Cargo workspace of three crates. `crates/core` holds the method, `crates/cli` a terminal program and `crates/web` the bridge to the browser. The page is in `site/`, with the map layers made by others in their own files there.

```sh
# The check in the terminal, writing map layers, the table and a JSON summary
cargo run --release -p disturbance-cli -- run --geojson boundary.geojson --out results

# The radar check
cargo run --release -p disturbance-cli -- run --sensor radar --geojson boundary.geojson --pre 2024-12-05/2025-02-04 --post 2025-12-05/2026-02-04

# The browser build, then a local server at http://localhost:8765
wasm-pack build crates/web --target web --out-dir ../../site/pkg --release --no-pack
python3 -m http.server 8765 --directory site
```

`bench/` holds the scripts and dated results behind the comparisons above.
