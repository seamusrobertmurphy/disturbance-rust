// Esri World Imagery Wayback, the dated archive of the high-resolution basemap.
//
// Ported from the GeoLibre disturbance checker, version 0.14.3, file
// src/reference/wayback.ts and the high-resolution archive part of
// src/panel/panel.ts. It replaces the Google Earth historical imagery timeline
// that the SOP relies on for visual confirmation, and it needs no account.
//
// Esri publishes every release of its World Imagery basemap as its own tile
// set, close to two hundred of them. It serves them anonymously, with
// access-control-allow-origin set to any origin.
//
// Sentinel-2 at 10 m shows that an index changed, and it cannot show what the
// ground holds. Wayback is often sub-metre, so a cutblock, a road, a landing or
// a blowdown patch can be identified by eye, and each picture is dated.
//
// This module keeps two dates apart. A release is when Esri published a
// version of the basemap. A capture is when the aircraft or satellite took the
// picture. The capture is often a year or more earlier, and it varies from
// place to place inside one release. Citing a release date as a capture date
// would be a factual error in a finding. The release list is therefore only a
// route to the capture metadata, which is read per location and shown beside it.
//
// Leaflet 1.9.4 must already be loaded as the global L.

const WAYBACK_CONFIG_URL =
  "https://s3-us-west-2.amazonaws.com/config.maptiles.arcgis.com/waybackconfig.json";

const WAYBACK_ATTRIBUTION =
  "Esri World Imagery Wayback, Esri, Maxar, Earthstar Geographics";

// ------------------------------------------------------------ releases

// ArcGIS tile paths run level, row, column, which is z, y, x. Renaming the
// placeholders is the whole conversion, because Leaflet substitutes by name.
function toXyzTemplate(itemUrl) {
  return itemUrl
    .replace("{level}", "{z}")
    .replace("{row}", "{y}")
    .replace("{col}", "{x}");
}

const TITLE_DATE = /(\d{4})-(\d{2})-(\d{2})/;

// One entry per release, keyed by Esri's release number. An entry is kept only
// when it has a tile template and a dated title.
function parseReleases(raw) {
  const releases = [];
  for (const [releaseNumber, entry] of Object.entries(raw ?? {})) {
    const url = entry?.itemURL;
    if (!url || !url.includes("{level}")) continue;
    const match = TITLE_DATE.exec(entry.itemTitle ?? "");
    if (!match) continue;
    releases.push({
      releaseNumber,
      releaseDate: `${match[1]}-${match[2]}-${match[3]}`,
      tileUrl: toXyzTemplate(url),
      metadataUrl: entry.metadataLayerUrl ?? null,
    });
  }
  // Newest first. A verifier almost always wants the most recent look, then
  // steps backwards until the disturbance disappears.
  releases.sort((a, b) => b.releaseDate.localeCompare(a.releaseDate));
  return releases;
}

let cached = null;

function loadReleases(signal) {
  if (!cached) {
    // Esri World Imagery Wayback release index, one entry per release.
    // https://s3-us-west-2.amazonaws.com/config.maptiles.arcgis.com/waybackconfig.json
    cached = fetch(WAYBACK_CONFIG_URL, { signal })
      .then((response) => {
        if (!response.ok) {
          throw new Error(
            `The Wayback release index returned ${response.status}. The dated basemap is unavailable; the analysis is unaffected.`,
          );
        }
        return response.json();
      })
      .then(parseReleases)
      .catch((error) => {
        // A failure is not cached, so a passing network fault does not
        // disable the timeline for the rest of the session.
        cached = null;
        throw error;
      });
  }
  return cached;
}

// ------------------------------------------------------------ captures

const EMPTY_CAPTURE = Object.freeze({
  captureDate: null,
  resolution: null,
  source: null,
  provider: null,
  accuracy: null,
});

// The capture metadata at a point, for one release.
//
// Identify is used rather than query, because the metadata is split across
// fourteen layers by resolution. Only the layers drawn at the given scale
// answer, and the finest one that answers gives the figures a verifier quotes.
async function captureAt(release, lon, lat, signal) {
  if (!release.metadataUrl) return EMPTY_CAPTURE;

  const pad = 0.02;
  const params = new URLSearchParams({
    geometry: JSON.stringify({ x: lon, y: lat }),
    geometryType: "esriGeometryPoint",
    sr: "4326",
    layers: "all",
    tolerance: "2",
    mapExtent: `${lon - pad},${lat - pad},${lon + pad},${lat + pad}`,
    imageDisplay: "600,600,96",
    returnGeometry: "false",
    f: "json",
  });

  // Esri World Imagery Wayback capture metadata, one map service per release.
  // Its address is read from the release index at
  // https://s3-us-west-2.amazonaws.com/config.maptiles.arcgis.com/waybackconfig.json
  // and looks like https://metadata.maptiles.arcgis.com/arcgis/rest/services/World_Imagery_Metadata_2026_r10/MapServer
  const response = await fetch(`${release.metadataUrl}/identify?${params}`, {
    signal,
  });
  if (!response.ok) return EMPTY_CAPTURE;

  const payload = await response.json();
  const attributes = payload?.results?.[0]?.attributes;
  if (!attributes) return EMPTY_CAPTURE;

  return {
    captureDate: normaliseDate(attributes.SRC_DATE2 ?? attributes.SRC_DATE),
    resolution: attributes.SRC_RES ?? null,
    source: attributes.SRC_DESC ?? null,
    provider: attributes.NICE_DESC ?? attributes.NICE_NAME ?? null,
    accuracy: attributes.SRC_ACC ?? null,
  };
}

// Turns 7/14/2025 or 20250714 into 2025-07-14. Anything else is passed
// through unchanged rather than guessed at.
function normaliseDate(value) {
  if (!value) return null;
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  const slashed = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  if (slashed) {
    return `${slashed[3]}-${slashed[1].padStart(2, "0")}-${slashed[2].padStart(2, "0")}`;
  }
  return value;
}

// The distinct looks available over a point.
//
// Releases are global publication events. At Sayward the release of 31 August
// 2023 carries imagery captured on 8 May 2019. Most consecutive releases carry
// the identical picture, because nothing was reflown there. A verifier stepping
// through them would see the same trees under five different dates, with no
// way to know which date to write down.
//
// The releases are therefore sampled, the capture date at the point is read for
// each, and only the first release showing each distinct capture is kept. What
// comes back is the list of times this place was actually photographed.
//
// Sampling every stride-th release finds every capture that persisted across
// more than stride releases, which in practice is all of them. It costs a
// twentieth of the traffic of reading all two hundred releases.
async function distinctLooks(releases, lon, lat, options = {}) {
  const stride = options.stride ?? 6;
  const concurrency = options.concurrency ?? 6;

  const sampled = releases.filter(
    (_, index) => index % stride === 0 || index === releases.length - 1,
  );

  const looks = new Array(sampled.length).fill(null);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, sampled.length) }, async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= sampled.length) return;
        const release = sampled[index];
        try {
          const capture = await captureAt(release, lon, lat, options.signal);
          if (capture.captureDate) looks[index] = { release, capture };
        } catch {
          // One unreachable metadata service must not lose the whole timeline.
        }
      }
    }),
  );

  const seen = new Set();
  const distinct = [];
  // Releases are newest first, so the first release showing a capture is the
  // most recent one that still carries it. That is the newest view of each
  // distinct photograph, which is what a verifier steps back through.
  for (const look of looks) {
    if (!look?.capture.captureDate) continue;
    if (seen.has(look.capture.captureDate)) continue;
    seen.add(look.capture.captureDate);
    distinct.push(look);
  }
  distinct.sort((a, b) =>
    (b.capture.captureDate ?? "").localeCompare(a.capture.captureDate ?? ""),
  );
  return distinct;
}

// The looks that bracket a pair of reporting windows, by capture date.
//
// The before look is the newest capture at or before the end of the pre
// window. The after look is the newest at or before the end of the post
// window. Both may be the same look. Either may be null when no aerial or
// satellite pass covered the site in that period. A null is a real answer, and
// the panel says so rather than falling back to a nearby date.
function bracketLooks(looks, preEnd, postEnd) {
  const onOrBefore = (date) =>
    looks.find((look) => (look.capture.captureDate ?? "") <= date) ?? null;
  return {
    before: onOrBefore(preEnd),
    after: onOrBefore(postEnd),
    latest: looks[0] ?? null,
  };
}

// The checker's error wording, with the network message naming the Wayback
// hosts instead of the Sentinel-2 catalogue hosts.
function describeError(error) {
  if (error && error.name === "AbortError") return "The request was cancelled.";
  const message =
    error instanceof Error ? error.message : String(error ?? "Unknown error");
  // A cross-origin block and a dead network look the same to fetch, so the
  // message covers both without asserting either.
  if (/failed to fetch|networkerror|load failed/i.test(message)) {
    return "The Wayback archive could not be reached. Check the network connection. On a corporate network, s3-us-west-2.amazonaws.com, wayback.maptiles.arcgis.com and metadata.maptiles.arcgis.com need to be reachable over HTTPS.";
  }
  if (/\b429\b|too many requests/i.test(message)) {
    return "The archive is rate limiting this connection. Wait a minute and try again.";
  }
  if (/\b5\d\d\b/.test(message)) {
    return `${message} This is a fault at the data provider. Trying again shortly usually clears it.`;
  }
  return message;
}

// ------------------------------------------------------------ page

const STYLE_ID = "wbk-style";
const PANE = "wbkWaybackPane";

const CSS = `
.wbk-root { color: var(--ink); font-size: 14px; }
.wbk-root .wbk-label { display: block; color: var(--muted); font-size: 13px; margin: 0 0 4px; }
.wbk-root .wbk-select { width: 100%; box-sizing: border-box; font: inherit; color: inherit; background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 5px 6px; }
.wbk-root .wbk-hint { color: var(--muted); font-size: 12.5px; margin: 6px 0; }
.wbk-root .wbk-card { background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 8px 10px; margin: 8px 0; }
.wbk-root .wbk-capture { font-size: 16px; font-weight: 600; font-variant-numeric: tabular-nums; }
.wbk-root .wbk-grid { display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; margin: 6px 0 0; font-size: 13px; }
.wbk-root .wbk-grid dt { color: var(--muted); margin: 0; }
.wbk-root .wbk-grid dd { margin: 0; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
.wbk-root .wbk-note { background: var(--warn-bg); border: 1px solid var(--warn-line); border-radius: 6px; padding: 6px 8px; margin: 8px 0; font-size: 13px; }
.wbk-root .wbk-note strong { display: block; margin-bottom: 2px; }
.wbk-root .wbk-btn { font: inherit; font-size: 13px; color: var(--ink); background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 5px 10px; cursor: pointer; width: auto; }
.wbk-root .wbk-btn:hover { border-color: var(--accent); }
.wbk-root .wbk-btn.wbk-on, .wbk-root .wbk-btn.wbk-main { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
.wbk-root .wbk-btn.wbk-main { width: 100%; padding: 8px; font-weight: 600; font-size: 14px; }
.wbk-root .wbk-sub { font-size: 14px; font-weight: 600; margin: 14px 0 6px; }
.wbk-root .wbk-look { display: grid; grid-template-columns: 1fr auto; column-gap: 8px; align-items: center; padding: 6px 0; border-bottom: 1px solid var(--line); }
.wbk-root .wbk-look-date { font-weight: 600; font-variant-numeric: tabular-nums; }
.wbk-root .wbk-look-tag { margin-left: 6px; padding: 0 6px; border-radius: 9px; font-size: 12px; background: var(--accent); color: var(--accent-ink); }
.wbk-root .wbk-look-meta { grid-column: 1; color: var(--muted); font-size: 12.5px; }
.wbk-root .wbk-look .wbk-btn { grid-column: 2; grid-row: 1 / span 2; }
`;

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function button(label, onClick, className = "") {
  const node = el("button", `wbk-btn ${className}`.trim(), label);
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
}

function notice(title, body) {
  const box = el("div", "wbk-note");
  box.setAttribute("role", "status");
  box.appendChild(el("strong", null, title));
  box.appendChild(el("span", null, body));
  return box;
}

function grid(rows) {
  const list = el("dl", "wbk-grid");
  for (const [label, value] of rows) {
    if (value === null || value === undefined || value === "") continue;
    list.appendChild(el("dt", null, label));
    list.appendChild(el("dd", null, value));
  }
  return list;
}

function pointText(point) {
  const where = point.from === "centre" ? "the map centre" : "the chosen point";
  return `Read at ${point.lat.toFixed(5)}, ${point.lon.toFixed(5)}, ${where}.`;
}

function samePoint(a, b) {
  return !!a && !!b && Math.abs(a.lat - b.lat) < 1e-7 && Math.abs(a.lon - b.lon) < 1e-7;
}

// Builds a release picker in the container element. Choosing a release adds
// its tiles to the map as one Leaflet tile layer, replacing any earlier one. It
// then shows the capture date, source and resolution at the focus point.
//
// getFocus returns { lat, lon } or null. When it gives nothing, the map centre
// is used and followed as the map moves. setFocus(lat, lon) sets an explicit
// point that overrides getFocus, and setFocus() with no point clears it.
//
// getWindows is optional and returns { preEnd, postEnd } as ISO dates, or null.
// When it gives both, the photographs list marks the pre window and post window
// looks, as the checker does for its first reporting period.
//
// Returns { setFocus(lat, lon), remove() }.
export async function createWayback(map, container, getFocus, getWindows) {
  injectStyle();
  if (!map.getPane(PANE)) {
    // This pane sits above every basemap in the tile pane at 200, and below
    // the result overlays at 400. The archive is context for the analysis, not
    // a competitor to it.
    map.createPane(PANE).style.zIndex = "250";
  }

  const state = {
    releases: [],
    releasesStatus: "loading",
    releasesError: null,
    selected: null,
    capture: null,
    captureStatus: "idle",
    captureError: null,
    capturePoint: null,
    looks: [],
    looksStatus: "idle",
    looksError: null,
    looksPoint: null,
  };

  let override = null;
  let tileLayer = null;
  let captureController = null;
  let looksController = null;
  let moveTimer = null;
  let removed = false;

  const root = el("div", "wbk-root");
  const pickerBox = el("div");
  const detailsBox = el("div");
  const looksBox = el("div");
  root.append(pickerBox, detailsBox, looksBox);
  container.appendChild(root);

  const select = el("select", "wbk-select");
  select.id = `wbk-release-${Math.random().toString(36).slice(2, 8)}`;
  select.addEventListener("change", () => {
    const release = state.releases.find((r) => r.releaseNumber === select.value) ?? null;
    selectRelease(release);
  });

  function focus() {
    if (override) return { ...override, from: "point" };
    let given = null;
    try {
      given = typeof getFocus === "function" ? getFocus() : null;
    } catch {
      given = null;
    }
    if (given && Number.isFinite(given.lat) && Number.isFinite(given.lon)) {
      return { lat: given.lat, lon: given.lon, from: "point" };
    }
    const centre = map.getCenter().wrap();
    return { lat: centre.lat, lon: centre.lng, from: "centre" };
  }

  function windows() {
    try {
      const value = typeof getWindows === "function" ? getWindows() : null;
      if (value && typeof value.preEnd === "string" && typeof value.postEnd === "string") {
        return value;
      }
    } catch {
      // A failing window lookup only loses the labels.
    }
    return null;
  }

  // ---------------------------------------------------------- picker

  function renderPicker() {
    pickerBox.replaceChildren();
    const label = el("label", "wbk-label", "Esri release, newest first");
    label.htmlFor = select.id;
    pickerBox.appendChild(label);

    if (state.releasesStatus === "error") {
      pickerBox.appendChild(
        notice(
          "The archive could not be read",
          state.releasesError ?? "The dated basemap is unavailable. The analysis is unaffected.",
        ),
      );
      pickerBox.appendChild(button("Try again", () => void load()));
      return;
    }

    select.replaceChildren();
    if (state.releasesStatus === "loading") {
      select.appendChild(el("option", null, "Loading the release list"));
      select.disabled = true;
    } else {
      const none = el("option", null, "None");
      none.value = "";
      select.appendChild(none);
      for (const release of state.releases) {
        const option = el("option", null, `Released ${release.releaseDate}`);
        option.value = release.releaseNumber;
        select.appendChild(option);
      }
      select.disabled = false;
      select.value = state.selected ? state.selected.releaseNumber : "";
    }
    pickerBox.appendChild(select);
    pickerBox.appendChild(
      el(
        "p",
        "wbk-hint",
        "A release is when Esri published a version of the basemap. The capture date is when the picture was taken, and it varies from place to place. Cite the capture date.",
      ),
    );
  }

  async function load() {
    state.releasesStatus = "loading";
    state.releasesError = null;
    renderPicker();
    try {
      state.releases = await loadReleases();
      state.releasesStatus = "ready";
    } catch (error) {
      state.releasesStatus = "error";
      state.releasesError = describeError(error);
    }
    if (!removed) renderPicker();
  }

  function selectRelease(release) {
    if (tileLayer) {
      map.removeLayer(tileLayer);
      tileLayer = null;
    }
    state.selected = release;
    if (state.releasesStatus === "ready") select.value = release ? release.releaseNumber : "";
    if (release) {
      // Esri World Imagery Wayback tiles for this release. The template comes
      // from the release index at
      // https://s3-us-west-2.amazonaws.com/config.maptiles.arcgis.com/waybackconfig.json
      tileLayer = L.tileLayer(release.tileUrl, {
        pane: PANE,
        maxZoom: 19,
        attribution: WAYBACK_ATTRIBUTION,
      }).addTo(map);
    }
    renderLooks();
    void queryCapture();
  }

  // ---------------------------------------------------------- capture

  async function queryCapture() {
    if (captureController) captureController.abort();
    captureController = null;
    const release = state.selected;
    if (!release) {
      state.capture = null;
      state.captureStatus = "idle";
      renderDetails();
      return;
    }
    const controller = new AbortController();
    captureController = controller;
    const point = focus();
    state.capturePoint = point;
    state.captureStatus = "loading";
    state.captureError = null;
    renderDetails();
    try {
      const capture = await captureAt(release, point.lon, point.lat, controller.signal);
      if (controller.signal.aborted) return;
      state.capture = capture;
      state.captureStatus = "ready";
    } catch (error) {
      if (controller.signal.aborted) return;
      state.captureStatus = "error";
      state.captureError = describeError(error);
    }
    if (!removed) renderDetails();
  }

  function renderDetails() {
    detailsBox.replaceChildren();
    const release = state.selected;
    if (!release) {
      if (state.releasesStatus === "ready") {
        detailsBox.appendChild(
          el(
            "p",
            "wbk-hint",
            "Choose a release to draw it on the map and read when its picture was taken at this point.",
          ),
        );
      }
      return;
    }

    const point = state.capturePoint;
    const card = el("div", "wbk-card");
    detailsBox.appendChild(card);

    if (state.captureStatus === "loading") {
      card.appendChild(el("div", "wbk-hint", "Reading the capture date at this point."));
      card.appendChild(grid([["Released", release.releaseDate]]));
      return;
    }

    if (state.captureStatus === "error") {
      card.appendChild(
        notice(
          "The capture date could not be read",
          `${state.captureError} The release date is not a substitute for it.`,
        ),
      );
      card.appendChild(grid([["Released", release.releaseDate]]));
      card.appendChild(button("Try again", () => void queryCapture()));
      return;
    }

    const capture = state.capture ?? EMPTY_CAPTURE;
    if (!capture.captureDate) {
      card.appendChild(
        notice(
          "No capture date at this point",
          release.metadataUrl
            ? "The metadata service gives no capture date for this release here. Do not cite the release date in its place."
            : "This release has no capture metadata service, so its imagery cannot be dated here. Do not cite the release date in its place.",
        ),
      );
      card.appendChild(grid([["Released", release.releaseDate]]));
    } else {
      card.appendChild(el("div", "wbk-capture", `Captured ${capture.captureDate}`));
      card.appendChild(
        grid([
          ["Resolution", capture.resolution ? `${capture.resolution} m` : null],
          ["Source", capture.source],
          ["Provider", capture.provider],
          ["Accuracy", capture.accuracy ? `${capture.accuracy} m` : null],
          ["Released", release.releaseDate],
        ]),
      );
    }
    if (point) card.appendChild(el("div", "wbk-hint", pointText(point)));
  }

  // ---------------------------------------------------------- photographs

  async function findLooks() {
    if (looksController) looksController.abort();
    const controller = new AbortController();
    looksController = controller;
    const point = focus();
    state.looksPoint = point;
    state.looksStatus = "loading";
    state.looksError = null;
    renderLooks();
    try {
      const releases = await loadReleases();
      const looks = await distinctLooks(releases, point.lon, point.lat, {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      state.looks = looks;
      state.looksStatus = "ready";
    } catch (error) {
      if (controller.signal.aborted) return;
      state.looksStatus = "error";
      state.looksError = describeError(error);
    }
    if (!removed) renderLooks();
  }

  function renderLook(look, bracket) {
    const row = el("div", "wbk-look");
    const active = state.selected === look.release;

    const labels = [];
    if (bracket.before && bracket.before === look) labels.push("pre window");
    if (bracket.after && bracket.after === look) labels.push("post window");

    const head = el("div");
    head.appendChild(el("span", "wbk-look-date", look.capture.captureDate ?? "undated"));
    if (labels.length > 0) head.appendChild(el("span", "wbk-look-tag", labels.join(", ")));
    row.appendChild(head);

    const parts = [
      look.capture.resolution ? `${look.capture.resolution} m` : null,
      look.capture.source,
      look.capture.provider,
      look.capture.accuracy ? `accuracy ${look.capture.accuracy} m` : null,
    ].filter(Boolean);
    row.appendChild(
      button(active ? "Hide" : "Show", () => selectRelease(active ? null : look.release), active ? "wbk-on" : ""),
    );
    row.appendChild(el("div", "wbk-look-meta", parts.join(", ")));
    return row;
  }

  function renderLooks() {
    looksBox.replaceChildren();
    looksBox.appendChild(el("div", "wbk-sub", "Distinct photographs"));

    if (state.looksStatus === "idle") {
      looksBox.appendChild(button("Find available imagery", () => void findLooks(), "wbk-main"));
      looksBox.appendChild(
        el(
          "p",
          "wbk-hint",
          "This searches Esri's dated World Imagery archive for every distinct photograph of this site. It takes around twenty seconds, because it reads capture metadata release by release.",
        ),
      );
      return;
    }

    if (state.looksStatus === "loading") {
      looksBox.appendChild(el("p", "wbk-hint", "Reading capture dates. This takes around twenty seconds."));
      return;
    }

    if (state.looksStatus === "error") {
      looksBox.appendChild(
        notice(
          "The archive could not be read",
          state.looksError ?? "The dated basemap is unavailable. The analysis is unaffected.",
        ),
      );
      looksBox.appendChild(button("Try again", () => void findLooks()));
      return;
    }

    if (state.looks.length === 0) {
      looksBox.appendChild(
        notice(
          "No high-resolution imagery found here",
          "The archive holds no dated capture over this area. Outside the United States and Europe this is common in remote terrain.",
        ),
      );
      looksBox.appendChild(button("Search again", () => void findLooks()));
      return;
    }

    const period = windows();
    const bracket = period
      ? bracketLooks(state.looks, period.preEnd, period.postEnd)
      : { before: null, after: null, latest: null };

    // This warning addresses the error the section exists to prevent. A
    // release is a publication event and a capture is a photograph. Consecutive releases usually carry
    // the identical picture, so a verifier stepping through release dates can
    // write down a date four years away from the imagery in front of them.
    if (
      bracket.before &&
      bracket.after &&
      bracket.before.capture.captureDate === bracket.after.capture.captureDate
    ) {
      looksBox.appendChild(
        notice(
          "No independent look inside the post window",
          `The newest capture at or before both window ends is the same photograph, from ${bracket.before.capture.captureDate}. High-resolution imagery cannot confirm or refute a change between these two dates here, and quoting it as if it could would misdate the evidence.`,
        ),
      );
    }

    for (const look of state.looks) looksBox.appendChild(renderLook(look, bracket));

    looksBox.appendChild(
      el(
        "p",
        "wbk-hint",
        `Dates shown are capture dates read from the archive's own metadata at this location, not release dates. ${WAYBACK_ATTRIBUTION}.`,
      ),
    );
    if (state.looksPoint) looksBox.appendChild(el("p", "wbk-hint", pointText(state.looksPoint)));
  }

  // ---------------------------------------------------------- map moves

  // When the focus falls back to the map centre, or getFocus gives a new
  // point, the capture details follow it after the map settles.
  function onMoveEnd() {
    window.clearTimeout(moveTimer);
    moveTimer = window.setTimeout(() => {
      if (removed || !state.selected) return;
      if (samePoint(focus(), state.capturePoint)) return;
      void queryCapture();
    }, 400);
  }
  map.on("moveend", onMoveEnd);

  renderPicker();
  renderDetails();
  renderLooks();
  await load();

  return {
    setFocus(lat, lon) {
      override = Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
      const point = focus();
      // A photographs list read at another point no longer describes this one.
      if (state.looksStatus !== "idle" && !samePoint(point, state.looksPoint)) {
        if (looksController) looksController.abort();
        looksController = null;
        state.looks = [];
        state.looksStatus = "idle";
        state.looksPoint = null;
        renderLooks();
      }
      void queryCapture();
    },
    remove() {
      removed = true;
      if (captureController) captureController.abort();
      if (looksController) looksController.abort();
      window.clearTimeout(moveTimer);
      map.off("moveend", onMoveEnd);
      if (tileLayer) map.removeLayer(tileLayer);
      tileLayer = null;
      root.remove();
    },
  };
}
