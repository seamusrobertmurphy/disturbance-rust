// The page: the map, the boundary, the periods, the thresholds, the site data
// and the results. The check itself runs in Rust, in worker.js. The map
// layers made by other people (corroboration, the dated imagery archive, the
// season charts and the parcel lookup) live in their own files and are loaded
// on demand, so a failure in one cannot stop the check.

const $ = (id) => document.getElementById(id);
const optional = (path) => import(path).catch((error) => {
  console.warn(`${path} did not load`, error);
  return null;
});

// ------------------------------------------------------------ constants

const DELTAS = {
  dNDVI: { sensor: "sentinel-2", meaning: "canopy loss", defaults: { low: 0.1, moderate: 0.2, high: 0.35 }, step: 0.01, unit: "", palette: ["#FFEDA0", "#FC4E2A", "#800026"] },
  dNDMI: { sensor: "sentinel-2", meaning: "moisture stress", defaults: { low: 0.15, moderate: 0.3, high: 0.45 }, step: 0.01, unit: "", palette: ["#FEB24C", "#FD8D3C", "#B10026"] },
  dNBR: { sensor: "sentinel-2", meaning: "burn severity", defaults: { low: 0.1, moderate: 0.27, high: 0.44 }, step: 0.01, unit: "", palette: ["#FFEDA0", "#FC4E2A", "#800026"] },
  dVH: { sensor: "sentinel-1", meaning: "radar canopy loss", defaults: { low: 2, moderate: 2.5, high: 3.5 }, step: 0.1, unit: " dB", palette: ["#FFEDA0", "#FC4E2A", "#800026"] },
};
const SENSOR_NAME = { "sentinel-2": "Sentinel-2 optical", "sentinel-1": "Sentinel-1 radar" };
const SENSOR_NOTE = {
  "sentinel-2": "The SOP's check. Three indices from a clear look at the ground in both windows.",
  "sentinel-1": "Reads the drop in VH backscatter instead, which sees through cloud and snow and covers winter harvest on frozen ground. It produces one layer, dVH. Set both windows in the same part of winter, after freeze-up and before thaw, for example 5 December to 4 February.",
};
const DEFAULT_WINDOWS = {
  "sentinel-2": ["2025-08-01", "2025-09-01", "2026-08-01", "2026-09-01"],
  "sentinel-1": ["2024-12-05", "2025-02-04", "2025-12-05", "2026-02-04"],
};
const CLASS_NAMES = { 1: "Low", 2: "Moderate", 3: "High" };
const SITE_ROLES = {
  smz: { label: "Streamside management zones", colour: "#4ade80", hint: "Drawn as a dashed overlay so disturbance inside a zone is obvious." },
  plots: { label: "Plot points", colour: "#facc15", hint: "Each point is labelled with its plot identifier so screenshots can be oriented." },
  harvest: { label: "Reported harvest", colour: "#c084fc", hint: "The harvest the developer reported, drawn as a dashed outline and never an input. A patch inside it is reported harvest behaving as it should, and one outside it is the finding." },
};
// The checker's detectLabelField, highest score wins.
const LABEL_PATTERNS = [
  [/^plot[\s_-]*(id|no|num|number)$/i, 100],
  [/^plot$/i, 90],
  [/^(id|name)[\s_-]*plot$/i, 85],
  [/plot/i, 70],
  [/^(point|site|stand)[\s_-]*(id|no|num|number)$/i, 60],
  [/^(id|fid|objectid|name|label)$/i, 40],
];
const SEARCH_URLS = {
  "earth-search": "https://earth-search.aws.element84.com/v1/search",
  "planetary-computer": "https://planetarycomputer.microsoft.com/api/stac/v1/search",
};

// ---------------------------------------------------------------- state

const state = {
  sensor: "sentinel-2",
  aoi: null, // { kind: "rectangle", bbox } or { kind: "geojson", geometry }
  aoiLabel: "",
  periods: [],
  breaks: Object.fromEntries(Object.entries(DELTAS).map(([id, d]) => [id, { ...d.defaults }])),
  justifications: Object.fromEntries(Object.keys(DELTAS).map((id) => [id, ""])),
  results: [], // see addResult
  active: null,
  activeDelta: null,
  focus: null, // { lat, lon } for the dated imagery
  climate: null,
  corroboration: null,
  corroborationLayers: [],
  site: {}, // role -> { name, geojson, layer, fields, labelField }
  ranWith: null, // settings of the last run, for the stale note
};

function newPeriod(sensor = state.sensor) {
  const [a, b, c, d] = DEFAULT_WINDOWS[sensor];
  return { id: `P${state.periods.length + 1}`, preStart: a, preEnd: b, postStart: c, postEnd: d };
}
state.periods.push(newPeriod());

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

function deltaIds(sensor) {
  return Object.keys(DELTAS).filter((id) => DELTAS[id].sensor === sensor);
}

function deviates(id) {
  const b = state.breaks[id];
  const d = DELTAS[id].defaults;
  return b.low !== d.low || b.moderate !== d.moderate || b.high !== d.high;
}

function decimalsFor(id) {
  return DELTAS[id].step < 0.05 ? 2 : 1;
}

// ------------------------------------------------------------------ map

const map = L.map("map", { zoomControl: true }).setView([44.0, -122.5], 9);
for (const [name, z] of [["backdrop", 390], ["classes", 420], ["site", 450], ["boundary", 460]]) {
  map.createPane(name).style.zIndex = String(z);
}
map.getPane("backdrop").style.pointerEvents = "none";
map.getPane("classes").style.pointerEvents = "none";
// World Imagery, Esri
// https://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9
const imagery = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
  maxZoom: 19,
  attribution: "Imagery &copy; Esri, Maxar, Earthstar Geographics",
}).addTo(map);
// OpenStreetMap standard tiles
// https://www.openstreetmap.org/copyright
const streets = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors",
});
L.control.layers({ "Satellite imagery": imagery, "Street map": streets }, null, { position: "topright" }).addTo(map);
L.control.scale({ imperial: false }).addTo(map);
map.pm.setGlobalOptions({ pathOptions: { color: "#ffd400", weight: 2, fillOpacity: 0.05 } });

// ------------------------------------------------------------- boundary

let aoiLayer = null;
const BOUNDARY_STYLE = { color: "#00e5ff", weight: 2, fill: false, pane: "boundary" };

function setAoi(next, layer, label) {
  if (aoiLayer) map.removeLayer(aoiLayer);
  state.aoi = next;
  state.aoiLabel = label;
  aoiLayer = layer;
  if (layer) {
    layer.addTo(map);
    map.fitBounds(layer.getBounds(), { padding: [20, 20] });
    const c = layer.getBounds().getCenter();
    state.focus = { lat: c.lat, lon: c.lng };
    wayback?.setFocus(c.lat, c.lng);
  }
  $("aoi-status").textContent = label;
  $("run").disabled = !state.aoi;
  $("corroborate").disabled = !state.aoi;
  state.climate = null;
  if ($("season").open) showClimate();
  markStale();
}

map.on("pm:create", (event) => {
  const layer = event.layer;
  map.removeLayer(layer);
  if (event.shape === "Rectangle") {
    const b = layer.getBounds();
    setAoi({ kind: "rectangle", bbox: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()] }, L.rectangle(b, BOUNDARY_STYLE), "Rectangle drawn.");
  } else {
    const geometry = layer.toGeoJSON();
    setAoi({ kind: "geojson", geometry }, L.geoJSON(geometry, { style: BOUNDARY_STYLE, pane: "boundary" }), "Polygon drawn.");
  }
});

$("draw-rect").onclick = () => map.pm.enableDraw("Rectangle");
$("draw-poly").onclick = () => map.pm.enableDraw("Polygon", { finishOn: "dblclick" });
$("upload").onclick = () => $("file").click();

async function readVectorFile(file) {
  const name = file.name.toLowerCase();
  let geojson;
  if (name.endsWith(".zip")) {
    geojson = await shp(await file.arrayBuffer());
    if (Array.isArray(geojson)) geojson = { type: "FeatureCollection", features: geojson.flatMap((c) => c.features) };
  } else if (name.endsWith(".kml")) {
    geojson = toGeoJSON.kml(new DOMParser().parseFromString(await file.text(), "text/xml"));
  } else {
    geojson = JSON.parse(await file.text());
  }
  return geojson;
}

$("file").onchange = async () => {
  const file = $("file").files[0];
  $("file").value = "";
  if (!file) return;
  try {
    const geometry = await readVectorFile(file);
    const layer = L.geoJSON(geometry, { style: BOUNDARY_STYLE, pane: "boundary" });
    if (!layer.getLayers().length) throw new Error("The file holds no shapes.");
    const polygons = countPolygons(geometry);
    if (!polygons) throw new Error("The file holds no polygons, only points or lines.");
    setAoi({ kind: "geojson", geometry }, layer, `${file.name}, ${polygons} polygon${polygons === 1 ? "" : "s"}.`);
  } catch (error) {
    showError(`That file could not be read. ${error.message || error}`);
  }
};

function countPolygons(node) {
  if (!node || typeof node !== "object") return 0;
  switch (node.type) {
    case "FeatureCollection": return (node.features || []).reduce((n, f) => n + countPolygons(f), 0);
    case "Feature": return countPolygons(node.geometry);
    case "GeometryCollection": return (node.geometries || []).reduce((n, g) => n + countPolygons(g), 0);
    case "Polygon": return 1;
    case "MultiPolygon": return (node.coordinates || []).length;
    default: return 0;
  }
}

function aoiBounds() {
  if (!state.aoi) return null;
  if (state.aoi.kind === "rectangle") {
    const [a, b, c, d] = state.aoi.bbox;
    return [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
  }
  const b = aoiLayer.getBounds();
  return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
}

// The state parcel lookup, in parcels.js.
optional("./parcels.js").then((mod) => {
  if (!mod) return;
  mod.createParcelPicker(map, $("parcels"), (feature, label) => {
    const layer = L.geoJSON(feature, { style: BOUNDARY_STYLE, pane: "boundary" });
    setAoi({ kind: "geojson", geometry: feature }, layer, `Parcel ${label}.`);
  });
});

// ---------------------------------------------------------------- sensor

function setSensor(sensor) {
  if (sensor === state.sensor) return;
  const before = DEFAULT_WINDOWS[state.sensor];
  // Windows still on the other sensor's defaults move to this sensor's.
  for (const p of state.periods) {
    if (p.preStart === before[0] && p.preEnd === before[1] && p.postStart === before[2] && p.postEnd === before[3]) {
      [p.preStart, p.preEnd, p.postStart, p.postEnd] = DEFAULT_WINDOWS[sensor];
    }
  }
  state.sensor = sensor;
  for (const b of $("sensor").children) b.setAttribute("aria-pressed", String(b.dataset.sensor === sensor));
  showSensor();
  renderPeriods();
  renderBreaksEditor();
  markStale();
}

function showSensor() {
  $("sensor-note").textContent = SENSOR_NOTE[state.sensor];
  const optical = state.sensor === "sentinel-2";
  $("host-row").hidden = !optical;
  $("cloud-row").hidden = !optical;
}

for (const b of $("sensor").children) b.onclick = () => setSensor(b.dataset.sensor);

// --------------------------------------------------------------- periods

function periodChecks(p) {
  // The checker's checkPeriod, SOP Step 3, Step 8 and Appendix A.1, optical only.
  const out = [];
  const month = (d) => Number(d.slice(5, 7)) || 0;
  const months = [p.preStart, p.preEnd, p.postStart, p.postEnd].map(month);
  if (months.some((m) => m && !(m >= 6 && m <= 9))) {
    out.push({ title: `${p.id}: window falls outside the growing season`, detail: "Dormant-season composites corrupt dNDMI, because senescence raises SWIR1 reflectance before leaf-fall and produces a uniform false moisture-stress signal. Use July to September for both pre and post." });
  }
  if (month(p.preStart) !== month(p.postStart) || month(p.preEnd) !== month(p.postEnd)) {
    out.push({ title: `${p.id}: pre and post windows cover different months`, detail: "Phenology drift between mismatched windows is the most common source of false change. Use the same calendar window for pre and post." });
  }
  if (!(p.preStart < p.preEnd && p.postStart < p.postEnd)) {
    out.push({ title: `${p.id}: a window ends before it starts`, detail: "Each window's start date must come before its end date." });
  }
  return out;
}

function renderPeriods() {
  const box = $("periods");
  box.innerHTML = "";
  state.periods.forEach((p, i) => {
    const div = document.createElement("div");
    div.className = "period";
    div.innerHTML =
      `<div class="head">${p.id}${state.periods.length > 1 ? '<button class="small" data-remove>Remove</button>' : ""}</div>` +
      `<div class="row"><label>Before</label><input type="date" data-k="preStart" value="${p.preStart}"> to <input type="date" data-k="preEnd" value="${p.preEnd}"></div>` +
      `<div class="row"><label>After</label><input type="date" data-k="postStart" value="${p.postStart}"> to <input type="date" data-k="postEnd" value="${p.postEnd}"></div>`;
    for (const input of div.querySelectorAll("input")) {
      input.onchange = () => {
        p[input.dataset.k] = input.value;
        showPeriodChecks();
        if (state.climate) showClimate();
        markStale();
      };
    }
    const remove = div.querySelector("[data-remove]");
    if (remove) remove.onclick = () => {
      state.periods.splice(i, 1);
      state.periods.forEach((q, k) => (q.id = `P${k + 1}`));
      renderPeriods();
      if (state.climate) showClimate();
      markStale();
    };
    box.appendChild(div);
  });
  showPeriodChecks();
}

function showPeriodChecks() {
  const checks = state.sensor === "sentinel-2" ? state.periods.flatMap(periodChecks) : state.periods.flatMap((p) => periodChecks(p).filter((c) => c.title.includes("ends before")));
  $("period-checks").innerHTML = checks.map((c) => `<div class="note"><b>${escapeHtml(c.title)}</b>${escapeHtml(c.detail)}</div>`).join("");
}

$("add-period").onclick = () => {
  const last = state.periods[state.periods.length - 1];
  const shift = (d, years) => `${Number(d.slice(0, 4)) + years}${d.slice(4)}`;
  // A new period follows the last one, a year on.
  const p = last
    ? { id: `P${state.periods.length + 1}`, preStart: last.postStart, preEnd: last.postEnd, postStart: shift(last.postStart, 1), postEnd: shift(last.postEnd, 1) }
    : newPeriod();
  state.periods.push(p);
  renderPeriods();
  if (state.climate) showClimate();
  markStale();
};

// ----------------------------------------------------------- the season

let climateModule = null;
let climateFor = "";

async function showClimate() {
  const bounds = aoiBounds();
  if (!bounds) {
    $("climate").innerHTML = '<p class="muted">Set a boundary first.</p>';
    return;
  }
  climateModule = climateModule || (await optional("./climate.js"));
  if (!climateModule) {
    $("climate").innerHTML = '<p class="muted">The season charts could not be loaded.</p>';
    return;
  }
  const lat = (bounds[1] + bounds[3]) / 2;
  const lon = (bounds[0] + bounds[2]) / 2;
  const where = `${lat.toFixed(3)},${lon.toFixed(3)},${state.periods.map((p) => [p.preStart, p.postEnd].join()).join()}`;
  try {
    if (!state.climate || climateFor !== where) {
      $("climate").innerHTML = '<p class="muted">Reading NASA POWER.</p>';
      state.climate = await climateModule.loadClimate(lat, lon, state.periods);
      climateFor = where;
    }
    climateModule.renderClimate($("climate"), state.climate, state.periods);
  } catch (error) {
    state.climate = null;
    $("climate").innerHTML = `<p class="muted">NASA POWER did not answer. ${escapeHtml(error.message || error)}</p>`;
  }
  renderRecord();
}

$("season").addEventListener("toggle", () => {
  if ($("season").open) showClimate();
});

// ------------------------------------------------------------ thresholds

function renderBreaksEditor() {
  const ids = deltaIds(state.sensor);
  const rows = ids.map((id) => {
    const b = state.breaks[id];
    const step = DELTAS[id].step;
    const input = (k) => `<input type="number" step="${step}" data-id="${id}" data-k="${k}" value="${b[k]}">`;
    const adjusted = deviates(id) ? ' <span class="adjusted">adjusted</span>' : "";
    return `<tr><td>${id}${adjusted}<div class="muted">${escapeHtml(DELTAS[id].meaning)}</div></td><td>${input("low")}</td><td>${input("moderate")}</td><td>${input("high")}</td></tr>`;
  });
  const reasons = ids
    .filter(deviates)
    .map((id) => `<div class="row" style="display:block"><label for="why-${id}">Why ${id} moved off its defaults</label><textarea id="why-${id}" data-why="${id}" placeholder="Name the site condition behind the change.">${escapeHtml(state.justifications[id])}</textarea></div>`);
  $("breaks-editor").innerHTML =
    `<table class="breaks"><thead><tr><th>Index</th><th>Low</th><th>Moderate</th><th>High</th></tr></thead><tbody>${rows.join("")}</tbody></table>` +
    reasons.join("") +
    (ids.some(deviates) ? '<div class="row"><button class="small" id="reset-breaks">Reset to the defaults</button></div>' : "");
  for (const input of $("breaks-editor").querySelectorAll("input[data-k]")) {
    input.onchange = () => {
      const id = input.dataset.id;
      const next = { ...state.breaks[id], [input.dataset.k]: Number(input.value) };
      if (!(next.low < next.moderate && next.moderate < next.high)) {
        input.value = state.breaks[id][input.dataset.k];
        showError("Thresholds must rise from Low to Moderate to High.");
        return;
      }
      showError("");
      setBreaks(id, next);
    };
  }
  for (const box of $("breaks-editor").querySelectorAll("textarea[data-why]")) {
    box.oninput = () => {
      state.justifications[box.dataset.why] = box.value;
      renderRecord();
    };
  }
  const reset = $("reset-breaks");
  if (reset) reset.onclick = () => {
    for (const id of ids) state.breaks[id] = { ...DELTAS[id].defaults };
    renderBreaksEditor();
    scheduleReclassify();
  };
}

function setBreaks(id, next, { redrawEditor = true } = {}) {
  const wasAdjusted = deviates(id);
  state.breaks[id] = next;
  if (redrawEditor || wasAdjusted !== deviates(id)) renderBreaksEditor();
  else for (const k of ["low", "moderate", "high"]) {
    const input = $("breaks-editor").querySelector(`input[data-id="${id}"][data-k="${k}"]`);
    if (input) input.value = next[k];
  }
  scheduleReclassify();
}

// ------------------------------------------------------------- site data

function renderSiteData() {
  const box = $("site-data");
  box.innerHTML = "";
  for (const [role, meta] of Object.entries(SITE_ROLES)) {
    const held = state.site[role];
    const div = document.createElement("div");
    div.style.margin = "8px 0";
    let fieldPicker = "";
    if (held && role === "plots") {
      const options = ['<option value="">No label</option>', ...held.fields.map((f) => `<option ${f === held.labelField ? "selected" : ""}>${escapeHtml(f)}</option>`)].join("");
      const said = held.labelField ? `Detected "${escapeHtml(held.labelField)}". Change it if the plot identifier lives in another column.` : "No plot identifier was detected. Choose the column holding it.";
      fieldPicker = `<div class="row"><label for="plot-field">Label</label><select id="plot-field">${options}</select></div><div class="muted">${said}</div>`;
    }
    div.innerHTML =
      `<div class="row"><span class="swatch" style="background:${meta.colour}"></span><b style="font-size:14px">${meta.label}</b>` +
      `<button class="small" data-load style="margin-left:auto">${held ? "Replace" : "Load"}</button>${held ? '<button class="small" data-clear>Remove</button>' : ""}</div>` +
      `<div class="muted">${held ? escapeHtml(held.name) : meta.hint}</div>${fieldPicker}`;
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".geojson,.json,.zip,.kml";
    input.hidden = true;
    div.appendChild(input);
    div.querySelector("[data-load]").onclick = () => input.click();
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return;
      try {
        const geojson = await readVectorFile(file);
        loadSite(role, file.name, geojson);
      } catch (error) {
        showError(`That file could not be read. ${error.message || error}`);
      }
    };
    const clear = div.querySelector("[data-clear]");
    if (clear) clear.onclick = () => {
      map.removeLayer(state.site[role].layer);
      delete state.site[role];
      renderSiteData();
      renderLayers();
      renderRecord();
    };
    const picker = div.querySelector("#plot-field");
    if (picker) picker.onchange = () => {
      held.labelField = picker.value || null;
      drawSite(role);
      renderSiteData();
    };
    box.appendChild(div);
  }
}

function fieldsOf(geojson) {
  const fields = new Set();
  const features = geojson.type === "FeatureCollection" ? geojson.features : geojson.type === "Feature" ? [geojson] : [];
  for (const f of features) for (const k of Object.keys(f.properties || {})) fields.add(k);
  return [...fields];
}

function detectLabelField(fields) {
  let best = null;
  for (const field of fields) {
    for (const [test, score] of LABEL_PATTERNS) {
      if (test.test(field)) {
        if (!best || score > best.score) best = { field, score };
        break;
      }
    }
  }
  return best ? best.field : null;
}

function loadSite(role, name, geojson) {
  if (state.site[role]) map.removeLayer(state.site[role].layer);
  const fields = fieldsOf(geojson);
  state.site[role] = { name, geojson, fields, labelField: role === "plots" ? detectLabelField(fields) : null, layer: null, visible: true };
  drawSite(role);
  renderSiteData();
  renderLayers();
  renderRecord();
}

function drawSite(role) {
  const held = state.site[role];
  const colour = SITE_ROLES[role].colour;
  if (held.layer) map.removeLayer(held.layer);
  held.layer = L.geoJSON(held.geojson, {
    pane: "site",
    style: { color: colour, weight: 2, dashArray: role === "plots" ? null : "6 4", fill: role === "smz", fillOpacity: 0.12 },
    pointToLayer: (feature, latlng) => {
      const marker = L.circleMarker(latlng, { pane: "site", radius: 4, color: "#000", weight: 1, fillColor: colour, fillOpacity: 1 });
      const label = held.labelField ? feature.properties?.[held.labelField] : null;
      if (label !== null && label !== undefined && label !== "") {
        marker.bindTooltip(String(label), { permanent: true, direction: "right", className: "plot-label", offset: [4, 0] });
      }
      return marker;
    },
  });
  if (held.visible) held.layer.addTo(map);
}

// ------------------------------------------------------------------ run

let worker = null;
let generation = 0;
const pending = new Map();
let messageId = 0;

function showError(message) {
  $("error").textContent = message;
  $("error").hidden = !message;
}

function ensureWorker() {
  if (worker) return worker;
  generation += 1;
  worker = new Worker("worker.js", { type: "module" });
  worker.onmessage = (event) => {
    const m = event.data;
    const waiting = pending.get(m.key ?? m.id) || pending.get(m.id);
    if (m.type === "progress") {
      waiting?.progress?.(m.message, m.fraction);
      return;
    }
    if (!waiting) return;
    pending.delete(waiting.token);
    if (m.type === "error") waiting.reject(new Error(m.message));
    else waiting.resolve(m);
  };
  worker.onerror = (event) => {
    for (const w of pending.values()) w.reject(new Error(`The check stopped unexpectedly. ${event.message || ""}`));
    pending.clear();
  };
  return worker;
}

function ask(message, progress) {
  const token = message.key ?? message.id;
  return new Promise((resolve, reject) => {
    pending.set(token, { token, resolve, reject, progress });
    ensureWorker().postMessage(message);
  });
}

function stopWorker() {
  if (worker) worker.terminate();
  worker = null;
  for (const w of pending.values()) w.reject(new Error("Cancelled."));
  pending.clear();
  for (const r of state.results) r.held = false;
}

$("cancel").onclick = () => {
  stopWorker();
  $("progress-box").hidden = true;
  $("run").disabled = !state.aoi;
};

function settingsNow() {
  return JSON.stringify({
    sensor: state.sensor, aoi: state.aoi, periods: state.periods, host: $("host").value, cloud: $("cloud").value,
    cast: $("cast").checked, snow: $("snow").checked, coarse: $("coarse").checked,
  });
}

function markStale() {
  $("stale").hidden = !(state.ranWith && state.ranWith !== settingsNow());
}
for (const id of ["host", "cloud", "cast", "snow", "coarse"]) $(id).addEventListener("change", markStale);
$("shift").addEventListener("change", () => scheduleReclassify());

$("run").onclick = async () => {
  if (!state.aoi) return;
  showError("");
  const bad = state.periods.find((p) => !(p.preStart < p.preEnd && p.postStart < p.postEnd));
  if (bad) {
    showError(`${bad.id}: each window's start date must come before its end date.`);
    return;
  }
  const sensor = state.sensor;
  // A run of one sensor replaces that sensor's earlier results and keeps the other's.
  for (const r of state.results.filter((x) => x.sensor === sensor)) removeResult(r);
  $("run").disabled = true;
  $("progress-box").hidden = false;
  $("progress").value = 0;
  const started = performance.now();
  const ranAt = new Date();
  const settings = settingsNow();
  try {
    for (const [i, period] of state.periods.entries()) {
      const params = {
        aoi: state.aoi,
        pre_start: period.preStart,
        pre_end: period.preEnd,
        post_start: period.postStart,
        post_end: period.postEnd,
        host: $("host").value,
        normalise: $("shift").checked,
        max_cloud: Number($("cloud").value) || 30,
        mask: { reject_cast_shadow: $("cast").checked, reject_snow: $("snow").checked },
        concurrency: 12,
        coarse_read: $("coarse").checked,
        sensor,
        breaks: Object.fromEntries(deltaIds(sensor).map((id) => [id, state.breaks[id]])),
        label: period.id,
      };
      const key = `${sensor}:${period.id}:${Date.now()}`;
      const periodStarted = performance.now();
      const reply = await ask({ type: "run", key, params }, (message, fraction) => {
        $("progress").value = (i + fraction) / state.periods.length;
        const seconds = ((performance.now() - started) / 1000).toFixed(0);
        $("progress-text").textContent = `${period.id}, ${message}, ${seconds} s`;
      });
      addResult({ key, sensor, period: { ...period }, params, json: JSON.parse(reply.json), png: reply.png, seconds: (performance.now() - periodStarted) / 1000, ranAt });
    }
    state.ranWith = settings;
    markStale();
  } catch (error) {
    if (error.message !== "Cancelled.") showError(error.message);
  } finally {
    $("progress-box").hidden = true;
    $("run").disabled = !state.aoi;
    renderResults();
  }
};

// -------------------------------------------------------------- results

function addResult({ key, sensor, period, params, json, png, seconds, ranAt }) {
  const histogramChecks = json.deltas.reduce((n, d) => n + d.analysis.diagnostics.length, 0);
  const result = {
    key, sensor, period, params, json, seconds, ranAt, held: true, generation,
    baseChecks: json.diagnostics.slice(0, json.diagnostics.length - histogramChecks),
    layers: [],
  };
  const firstOfSensor = !state.results.some((r) => r.sensor === sensor);
  json.layers.forEach((layer, i) => {
    const [w, s, e, n] = layer.bounds;
    const url = URL.createObjectURL(new Blob([png[i]], { type: "image/png" }));
    const classes = Boolean(DELTAS[layer.key]);
    const overlay = L.imageOverlay(url, [[s, w], [n, e]], {
      opacity: Number($("opacity").value), className: "pixelated", interactive: false, pane: classes ? "classes" : "backdrop",
    });
    const visible = firstOfSensor && period.id === state.periods[0].id && (layer.key === "dNDVI" || layer.key === "dVH");
    if (visible) overlay.addTo(map);
    result.layers.push({ key: layer.key, name: layer.name, url, overlay, classes });
  });
  state.results.push(result);
  state.active = key;
  state.activeDelta = deltaIds(sensor)[0];
}

function removeResult(r) {
  for (const l of r.layers) {
    map.removeLayer(l.overlay);
    URL.revokeObjectURL(l.url);
  }
  state.results = state.results.filter((x) => x !== r);
  if (state.active === r.key) state.active = state.results[0]?.key ?? null;
}

function activeResult() {
  return state.results.find((r) => r.key === state.active) || state.results[0] || null;
}

function resultName(r) {
  return `${r.period.id} ${r.sensor === "sentinel-2" ? "optical" : "radar"}`;
}

function renderResults() {
  const r = activeResult();
  $("results").hidden = !r;
  renderLayers();
  renderRecord();
  if (!r) return;
  state.active = r.key;
  if (!DELTAS[state.activeDelta] || DELTAS[state.activeDelta].sensor !== r.sensor) state.activeDelta = deltaIds(r.sensor)[0];

  $("result-tabs").innerHTML = "";
  if (state.results.length > 1) {
    for (const x of state.results) {
      const b = document.createElement("button");
      b.className = "small";
      b.textContent = resultName(x);
      b.setAttribute("aria-pressed", String(x === r));
      b.onclick = () => {
        state.active = x.key;
        renderResults();
      };
      $("result-tabs").appendChild(b);
    }
  }

  const j = r.json;
  const s = j.stats;
  const views = r.sensor === "sentinel-2" ? "views" : "radar scenes";
  $("summary").innerHTML =
    `<p>${escapeHtml(resultName(r))} finished in ${r.seconds.toFixed(1)} s from ${escapeHtml(j.host)}. ` +
    `Downloaded ${(s.bytes / 1e6).toFixed(0)} MB in ${s.requests} requests. ` +
    `${j.pre.length} ${views} before and ${j.post.length} after.</p>`;
  const checks = [
    ...j.warnings.map((w) => ({ severity: "warning", title: "", detail: w })),
    ...j.diagnostics,
  ];
  $("checks").innerHTML = checks
    .map((c) => `<div class="${c.severity === "warning" ? "note" : "info"}">${c.title ? `<b>${escapeHtml(c.title)}</b>` : ""}${escapeHtml(c.detail)}${c.source ? ` <span class="muted">(${escapeHtml(c.source)})</span>` : ""}</div>`)
    .join("");

  renderHistograms(r);
  renderPatchTabs(r);
  renderBreaksUsed(r);
  const list = (items) =>
    `<ul class="plain">${items.map((v) => `<li>${v.date}${r.sensor === "sentinel-2" ? `, ${v.cloud_cover.toFixed(0)} per cent cloud, tile ${escapeHtml(v.tiles.join(" and "))}` : `, ${escapeHtml(v.tiles.join(""))}`}</li>`).join("")}</ul>`;
  $("views").innerHTML = `<div>Before, ${r.period.preStart} to ${r.period.preEnd}</div>${list(j.pre)}<div>After, ${r.period.postStart} to ${r.period.postEnd}</div>${list(j.post)}`;
}

function renderLayers() {
  const box = $("layers");
  box.innerHTML = "";
  const row = (name, on, legend, toggle) => {
    const label = document.createElement("label");
    label.className = "layer";
    label.innerHTML = `<input type="checkbox" ${on ? "checked" : ""}> ${escapeHtml(name)} <span class="legend">${legend || ""}</span>`;
    label.querySelector("input").onchange = (event) => toggle(event.target.checked);
    box.appendChild(label);
  };
  const group = (title) => {
    const div = document.createElement("div");
    div.className = "group";
    div.textContent = title;
    box.appendChild(div);
  };
  for (const r of state.results) {
    group(`${r.period.id}, ${SENSOR_NAME[r.sensor]}`);
    for (const l of [...r.layers].reverse()) {
      const palette = DELTAS[l.key]?.palette;
      const legend = palette ? ["Low", "Moderate", "High"].map((n, k) => `<span class="swatch" style="background:${palette[k]}"></span>${n}`).join(" ") : "";
      row(l.name, map.hasLayer(l.overlay), legend, (on) => (on ? l.overlay.addTo(map) : map.removeLayer(l.overlay)));
    }
  }
  const site = Object.entries(state.site);
  if (aoiLayer || site.length) group("Site data");
  if (aoiLayer) row("Project boundary", map.hasLayer(aoiLayer), '<span class="swatch" style="background:#00e5ff"></span>', (on) => (on ? aoiLayer.addTo(map) : map.removeLayer(aoiLayer)));
  for (const [role, held] of site) {
    row(SITE_ROLES[role].label, map.hasLayer(held.layer), `<span class="swatch" style="background:${SITE_ROLES[role].colour}"></span>`, (on) => {
      held.visible = on;
      on ? held.layer.addTo(map) : map.removeLayer(held.layer);
    });
  }
  if (state.corroborationLayers.length) {
    let last = null;
    for (const c of state.corroborationLayers) {
      if (c.group !== last) group(`Corroboration, ${c.group}`);
      last = c.group;
      row(c.name, map.hasLayer(c.layer), c.legend, (on) => (on ? c.layer.addTo(map) : map.removeLayer(c.layer)));
    }
  }
  if (!box.children.length) box.innerHTML = '<p class="muted">No layers yet.</p>';
  $("results").hidden = !state.results.length && !box.querySelector("input");
}

$("opacity").oninput = () => {
  for (const r of state.results) for (const l of r.layers) l.overlay.setOpacity(Number($("opacity").value));
};

// ------------------------------------------------------------ histograms

const SVG = "http://www.w3.org/2000/svg";
function svg(tag, attrs) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

// Ported from src/panel/histogram-plot.ts: bars on a square-root scale, the
// three breaks as draggable lines, the defaults drawn faintly.
function histogramPlot(id, histogram, suggestedLow) {
  const WIDTH = 360, HEIGHT = 110, PAD = 2, BOTTOM = 14;
  const starts = histogram.starts, counts = histogram.counts;
  const lo = starts.length ? starts[0] : -0.5;
  const hi = starts.length ? starts[starts.length - 1] : 0.8;
  const span = hi - lo || 1;
  const binWidth = starts.length > 1 ? starts[1] - starts[0] : 0.01;
  const decimals = Math.max(0, Math.ceil(-Math.log10(binWidth)) + 1);
  const plotHeight = HEIGHT - BOTTOM;
  const toX = (v) => PAD + ((v - lo) / span) * (WIDTH - PAD * 2);
  const toValue = (x) => lo + ((x - PAD) / (WIDTH - PAD * 2)) * span;
  const max = Math.max(0, ...counts);
  const scaleY = (c) => (max === 0 ? 0 : (Math.sqrt(c) / Math.sqrt(max)) * plotHeight);
  const barWidth = starts.length ? Math.max(1, (WIDTH - PAD * 2) / starts.length) : 1;
  const plot = svg("svg", { viewBox: `0 0 ${WIDTH} ${HEIGHT}`, preserveAspectRatio: "none", role: "img", "aria-label": `${id} histogram` });
  starts.forEach((start, i) => {
    const h = scaleY(counts[i]);
    if (h > 0) plot.appendChild(svg("rect", { x: toX(start), y: plotHeight - h, width: barWidth, height: h, class: "bar" }));
  });
  plot.appendChild(svg("line", { x1: PAD, y1: plotHeight, x2: WIDTH - PAD, y2: plotHeight, class: "axis" }));
  plot.appendChild(svg("line", { x1: toX(0), y1: 0, x2: toX(0), y2: plotHeight, class: "zero" }));
  if (suggestedLow !== null && suggestedLow !== undefined) {
    plot.appendChild(svg("line", { x1: toX(suggestedLow), y1: 0, x2: toX(suggestedLow), y2: plotHeight, class: "suggested" }));
  }
  const keys = ["low", "moderate", "high"];
  const lines = {}, hits = {};
  for (const k of keys) {
    const d = DELTAS[id].defaults[k];
    plot.appendChild(svg("line", { x1: toX(d), y1: 0, x2: toX(d), y2: plotHeight, class: "default" }));
    const b = state.breaks[id][k];
    lines[k] = plot.appendChild(svg("line", { x1: toX(b), y1: 0, x2: toX(b), y2: plotHeight, class: `break ${k}` }));
    hits[k] = plot.appendChild(svg("rect", { x: toX(b) - 6, y: 0, width: 12, height: plotHeight, class: "handle", tabindex: 0, role: "slider", "aria-label": `${id} ${k} class break`, "aria-valuenow": b.toFixed(2) }));
  }
  const clampOrder = (k, v) => {
    const b = state.breaks[id];
    const bounded = Math.min(hi, Math.max(lo, v));
    const step = binWidth / 2;
    if (k === "low") return Math.min(bounded, b.moderate - step);
    if (k === "moderate") return Math.min(Math.max(bounded, b.low + step), b.high - step);
    return Math.max(bounded, b.moderate + step);
  };
  const apply = (k, v) => {
    const next = Number(clampOrder(k, v).toFixed(decimals));
    if (next === state.breaks[id][k]) return;
    for (const key of [k]) {
      lines[key].setAttribute("x1", toX(next));
      lines[key].setAttribute("x2", toX(next));
      hits[key].setAttribute("x", toX(next) - 6);
      hits[key].setAttribute("aria-valuenow", next.toFixed(2));
    }
    setBreaks(id, { ...state.breaks[id], [k]: next }, { redrawEditor: false });
  };
  for (const k of keys) {
    const hit = hits[k];
    hit.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      hit.setPointerCapture(event.pointerId);
      const move = (e) => {
        const rect = plot.getBoundingClientRect();
        apply(k, toValue(((e.clientX - rect.left) / rect.width) * WIDTH));
      };
      const up = (e) => {
        hit.releasePointerCapture(e.pointerId);
        hit.removeEventListener("pointermove", move);
        hit.removeEventListener("pointerup", up);
      };
      hit.addEventListener("pointermove", move);
      hit.addEventListener("pointerup", up);
    });
    hit.addEventListener("keydown", (event) => {
      const step = event.shiftKey ? binWidth * 5 : binWidth;
      if (event.key === "ArrowLeft") { event.preventDefault(); apply(k, state.breaks[id][k] - step); }
      if (event.key === "ArrowRight") { event.preventDefault(); apply(k, state.breaks[id][k] + step); }
    });
  }
  const ticks = lo === -0.5 && Math.abs(hi - 0.79) < 0.02
    ? [-0.5, 0, 0.4, 0.8]
    : [...new Set([lo, 0, Math.round((lo + hi) / 2), hi])].filter((t) => t >= lo && t <= hi).sort((a, b) => a - b);
  for (const t of ticks) {
    const text = svg("text", { x: toX(t), y: HEIGHT - 3, class: "tick", "text-anchor": t === lo ? "start" : t === hi ? "end" : "middle" });
    text.textContent = t.toFixed(1);
    plot.appendChild(text);
  }
  return plot;
}

function renderHistograms(r) {
  const box = $("histograms");
  box.innerHTML = "";
  for (const d of r.json.deltas) {
    const div = document.createElement("div");
    div.className = "histogram";
    const shape = d.analysis.shape.replace(/-/g, " ");
    div.innerHTML = `<div class="title"><b>${d.id}</b><span>${escapeHtml(d.meaning)}</span><span class="shape">${escapeHtml(shape)}</span></div>`;
    div.appendChild(histogramPlot(d.id, d.histogram, d.analysis.suggested_low));
    box.appendChild(div);
  }
}

// ------------------------------------------------------------- redrawing

let reclassifyTimer = null;
let reclassifyRunning = false;
let reclassifyAgain = false;

function scheduleReclassify() {
  clearTimeout(reclassifyTimer);
  reclassifyTimer = setTimeout(reclassifyAll, 120);
}

// New breaks or a change of the shift switch redraw every held result in the
// worker, from the change values it kept, with nothing downloaded again.
async function reclassifyAll() {
  if (reclassifyRunning) {
    reclassifyAgain = true;
    return;
  }
  reclassifyRunning = true;
  try {
    let lost = 0;
    for (const r of state.results) {
      if (!r.held || r.generation !== generation || !worker) {
        lost += 1;
        continue;
      }
      const breaks = Object.fromEntries(deltaIds(r.sensor).map((id) => [id, state.breaks[id]]));
      const id = `re-${(messageId += 1)}`;
      const reply = await ask({ type: "reclassify", id, key: r.key, breaks, normalise: $("shift").checked });
      const c = JSON.parse(reply.json);
      r.json.deltas = c.deltas;
      r.json.patches = c.patches;
      r.json.diagnostics = [...r.baseChecks, ...c.diagnostics];
      c.layers.forEach((layer, i) => {
        const held = r.layers.find((l) => l.key === layer.key);
        if (!held) return;
        const url = URL.createObjectURL(new Blob([reply.png[i]], { type: "image/png" }));
        held.overlay.setUrl(url);
        URL.revokeObjectURL(held.url);
        held.url = url;
      });
    }
    if (lost && state.results.length) showError("Some results were drawn before a cancel and are no longer held, so they keep their old classes. Run the check again to redraw them.");
    if (state.results.length) {
      const r = activeResult();
      renderPatchTabs(r);
      renderBreaksUsed(r);
      const checks = [...r.json.warnings.map((w) => ({ severity: "warning", title: "", detail: w })), ...r.json.diagnostics];
      $("checks").innerHTML = checks
        .map((c) => `<div class="${c.severity === "warning" ? "note" : "info"}">${c.title ? `<b>${escapeHtml(c.title)}</b>` : ""}${escapeHtml(c.detail)}${c.source ? ` <span class="muted">(${escapeHtml(c.source)})</span>` : ""}</div>`)
        .join("");
      for (const div of $("histograms").querySelectorAll(".histogram")) {
        const id = div.querySelector("b").textContent;
        const d = r.json.deltas.find((x) => x.id === id);
        if (d) div.querySelector(".shape").textContent = d.analysis.shape.replace(/-/g, " ");
      }
    }
    renderRecord();
  } catch (error) {
    showError(error.message);
  } finally {
    reclassifyRunning = false;
    if (reclassifyAgain) {
      reclassifyAgain = false;
      scheduleReclassify();
    }
  }
}

// --------------------------------------------------------------- patches

let highlight = null;

function renderPatchTabs(r) {
  $("tabs").innerHTML = "";
  for (const d of r.json.deltas) {
    const b = document.createElement("button");
    b.textContent = `${d.id} (${d.patches_total})`;
    b.setAttribute("aria-pressed", String(d.id === state.activeDelta));
    b.onclick = () => {
      state.activeDelta = d.id;
      renderPatchTabs(r);
    };
    $("tabs").appendChild(b);
  }
  showPatches(r);
}

function showPatches(r) {
  const id = state.activeDelta;
  const d = r.json.deltas.find((x) => x.id === id);
  const rows = r.json.patches.filter((p) => p.delta === id);
  if (!d || !rows.length) {
    $("patches").innerHTML = `<p class="muted">No moderate or high patches on ${id}.</p>`;
    return;
  }
  const more = d.patches_total > rows.length ? `<div class="muted">The first ${rows.length} of ${d.patches_total} are listed; the CSV holds the same rows.</div>` : "";
  const unit = DELTAS[id].unit;
  $("patches").innerHTML =
    `<table><thead><tr><th>Class</th><th class="num">Latitude</th><th class="num">Longitude</th><th class="num">Peak ${id}${unit ? ` (${unit.trim()})` : ""}</th></tr></thead><tbody>` +
    rows.map((p, i) => `<tr class="click" data-i="${i}"><td><span class="swatch" style="background:${DELTAS[id].palette[p.class - 1]}"></span>${CLASS_NAMES[p.class]}</td><td class="num">${p.lat.toFixed(5)}</td><td class="num">${p.lon.toFixed(5)}</td><td class="num">${p.peak.toFixed(decimalsFor(id) + 1)}</td></tr>`).join("") +
    `</tbody></table>${more}`;
  for (const tr of $("patches").querySelectorAll("tr.click")) {
    tr.onclick = () => {
      const p = rows[Number(tr.dataset.i)];
      const [w, s, e, n] = p.bounds;
      if (highlight) map.removeLayer(highlight);
      highlight = L.rectangle([[s, w], [n, e]], { color: "#00e5ff", weight: 2, fill: false, pane: "boundary" }).addTo(map);
      map.fitBounds(highlight.getBounds(), { maxZoom: 16, padding: [60, 60] });
      for (const l of r.layers) if (l.key === p.delta && !map.hasLayer(l.overlay)) l.overlay.addTo(map);
      state.focus = { lat: p.lat, lon: p.lon };
      wayback?.setFocus(p.lat, p.lon);
      renderLayers();
    };
  }
}

function renderBreaksUsed(r) {
  const fmt = (v, id) => v.toFixed(decimalsFor(id) + 1);
  $("breaks").innerHTML =
    `<table><thead><tr><th>Index</th><th class="num">Low</th><th class="num">Moderate</th><th class="num">High</th><th>Shift</th></tr></thead><tbody>` +
    r.json.deltas.map((d) => {
      const n = d.normalisation;
      let shift;
      if (n.method === "median") shift = `${n.offset >= 0 ? "+" : ""}${n.offset.toFixed(2)} dB off the pixels`;
      else if (d.breaks_used.low !== d.breaks_set.low) shift = `${n.offset >= 0 ? "+" : ""}${n.offset.toFixed(3)}`;
      else shift = "none";
      const title = n.refusal ? ` title="${escapeHtml(n.refusal)}"` : "";
      return `<tr><td>${d.id}, ${escapeHtml(d.meaning)}</td><td class="num">${fmt(d.breaks_used.low, d.id)}</td><td class="num">${fmt(d.breaks_used.moderate, d.id)}</td><td class="num">${fmt(d.breaks_used.high, d.id)}</td><td${title}>${shift}</td></tr>`;
    }).join("") +
    `</tbody></table><div class="muted">${r.sensor === "sentinel-2"
      ? "SOP defaults are dNDVI 0.10, 0.20, 0.35; dNDMI 0.15, 0.30, 0.45; dNBR 0.10, 0.27, 0.44. A shift is applied only when at least half the pixels sit within 0.05 of the unchanged peak."
      : "Defaults are 2.0, 2.5 and 3.5 dB, from the checker's test against reported clearcuts near Cochrane, Ontario. The middle drop over the boundary is always taken off first, because the defaults were set after it."}</div>`;
}

$("csv").onclick = () => {
  if (!state.results.length) return;
  const lines = ["period,sensor,delta,meaning,class,latitude,longitude,peak_value,pre_window,post_window"];
  for (const r of state.results) {
    const meaning = Object.fromEntries(r.json.deltas.map((d) => [d.id, d.meaning]));
    for (const p of r.json.patches) {
      lines.push([r.period.id, r.sensor, p.delta, meaning[p.delta], CLASS_NAMES[p.class].toLowerCase(), p.lat.toFixed(6), p.lon.toFixed(6), p.peak.toFixed(3), `${r.period.preStart}/${r.period.preEnd}`, `${r.period.postStart}/${r.period.postEnd}`].join(","));
    }
  }
  download(lines.join("\n") + "\n", "text/csv", `flagged-patches-${new Date().toISOString().slice(0, 10)}.csv`);
};

function download(text, type, name) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------- visual check

let wayback = null;
optional("./wayback.js").then(async (mod) => {
  if (!mod) {
    $("wayback").innerHTML = '<p class="muted">The dated imagery could not be loaded.</p>';
    return;
  }
  try {
    // The active result's period, or the first period, tags the pictures
    // taken before and after its windows.
    const windows = () => {
      const p = activeResult()?.period || state.periods[0];
      return p ? { preEnd: p.preEnd, postEnd: p.postEnd } : null;
    };
    wayback = await mod.createWayback(map, $("wayback"), () => state.focus || { lat: map.getCenter().lat, lon: map.getCenter().lng }, windows);
  } catch (error) {
    $("wayback").innerHTML = `<p class="muted">Esri's archive did not answer. ${escapeHtml(error.message || error)}</p>`;
  }
});

// --------------------------------------------------------- corroboration

$("corroborate").onclick = async () => {
  const bounds = aoiBounds();
  if (!bounds) return;
  const mod = await optional("./corroborate.js");
  if (!mod) {
    $("corroboration").innerHTML = '<p class="muted">The corroboration records could not be loaded.</p>';
    return;
  }
  const years = state.periods.flatMap((p) => [p.preStart, p.postEnd]).map((d) => Number(d.slice(0, 4)));
  const span = { from: Math.min(...years), to: Math.max(...years) };
  for (const c of state.corroborationLayers) map.removeLayer(c.layer);
  state.corroborationLayers = [];
  $("corroborate").disabled = true;
  $("corroboration").innerHTML = '<p class="muted">Asking the registries.</p>';
  try {
    const found = await mod.loadCorroboration(map, bounds, span, (message) => {
      $("corroboration").innerHTML = `<p class="muted">${escapeHtml(message)}</p>`;
    });
    state.corroboration = { ...found, years: span };
    state.corroborationLayers = found.layers;
    $("corroboration").innerHTML =
      `<p class="muted">${span.from} to ${span.to}. ${found.layers.length} layer${found.layers.length === 1 ? "" : "s"} added to the layer list, switched off. Their sources are in the run record.</p>` +
      found.notes.map((n) => `<div class="note">${escapeHtml(n)}</div>`).join("") +
      `<pre class="record">${escapeHtml(found.record.join("\n"))}</pre>`;
  } catch (error) {
    $("corroboration").innerHTML = `<p class="muted">The registries did not answer. ${escapeHtml(error.message || error)}</p>`;
  } finally {
    $("corroborate").disabled = !state.aoi;
    renderLayers();
    renderRecord();
  }
};

// ------------------------------------------------------------ run record

// Ported from src/manifest.ts. It records every parameter, threshold, reason
// and check, and the sources. Areas and shares of the project are left out,
// because a spectral change is not known to be a loss of canopy until it has
// been checked on the ground.
function buildRecord() {
  if (!state.results.length && !state.climate && !state.corroboration) return "";
  const lines = [];
  const pad = (label) => label.padEnd(18);
  lines.push("Canopy Disturbance Check");
  lines.push("Sentinel-2 NDVI, NDMI and NBR, and Sentinel-1 VH, change between two windows");
  lines.push("");
  const first = state.results[0];
  lines.push(`${pad("Run at")}${(first?.ranAt || new Date()).toISOString()}`);
  const aoi = state.aoi
    ? state.aoi.kind === "rectangle"
      ? `rectangle W ${state.aoi.bbox[0].toFixed(5)} S ${state.aoi.bbox[1].toFixed(5)} E ${state.aoi.bbox[2].toFixed(5)} N ${state.aoi.bbox[3].toFixed(5)} (EPSG:4326)`
      : state.aoiLabel || "uploaded boundary"
    : "not set";
  lines.push(`${pad("Area of interest")}${aoi}`);
  lines.push(`${pad("Tool")}disturbance-rust, a port of disturbance-checker 0.14.3, ${location.href.split("?")[0]}`);
  const optical = state.results.find((r) => r.sensor === "sentinel-2");
  if (optical) {
    const p = optical.params;
    lines.push(`${pad("Catalogue")}${SEARCH_URLS[p.host]}`);
    lines.push(`${pad("Collection")}sentinel-2-l2a (Sentinel-2 L2A cloud-optimised GeoTIFFs)`);
    lines.push(`${pad("Radiometry")}the +1000 DN baseline offset removed where present`);
    lines.push(`${pad("Cloud removal")}scene classification (SCL), cast shadow ${p.mask.reject_cast_shadow ? "rejected" : "kept"}, snow ${p.mask.reject_snow ? "rejected" : "kept"}`);
    lines.push(`${pad("Scene filter")}eo:cloud_cover < ${p.max_cloud} percent, applied before download`);
    lines.push(`${pad("Reduction")}per-pixel median over surviving observations`);
    lines.push(`${pad("Pixel read")}${p.coarse_read ? "bands 2, 3, 4 and 8 from their 20 m copy (faster download, not the checker's pixels)" : "every band at its stored resolution, as the checker reads it"}`);
    lines.push(`${pad("Histogram")}130 fixed bins from -0.5 to 0.8, computed on every pixel`);
    lines.push(`${pad("Working grid")}native Sentinel-2 UTM, 20 m`);
  }
  lines.push("");

  for (const r of state.results) {
    const j = r.json;
    lines.push(`--- ${r.period.id}, ${SENSOR_NAME[r.sensor]} ---`);
    if (j.radar) {
      lines.push(`  Catalogue     https://planetarycomputer.microsoft.com/api/stac/v1/search`);
      lines.push(`  Collection    sentinel-1-rtc (terrain-flattened gamma naught, VH, 10 m, Microsoft Planetary Computer)`);
      lines.push(`  Orbits        relative orbit${j.radar.orbits.length > 1 ? "s" : ""} ${j.radar.orbits.join(", ")} (${j.radar.passes.join(", ")}), ${j.radar.dropped} scene(s) dropped`);
      lines.push(`  Reduction     per-pixel median of VH in decibels per window, 25 m focal mean`);
      lines.push(`  Scene shift   median drop of ${j.radar.shift_db >= 0 ? "+" : ""}${j.radar.shift_db.toFixed(2)} dB over the boundary subtracted from every pixel`);
      lines.push(`  Water         VH below -22 dB in either window masked`);
    }
    lines.push(`  Pre window    ${r.period.preStart} to ${r.period.preEnd}`);
    lines.push(`  Post window   ${r.period.postStart} to ${r.period.postEnd}`);
    lines.push(`  Overpasses    ${j.pre.length} pre, ${j.post.length} post`);
    lines.push(`  Pre dates     ${j.pre.map((o) => o.date).join(", ") || "none"}`);
    lines.push(`  Post dates    ${j.post.map((o) => o.date).join(", ") || "none"}`);
    lines.push(`  Grid          EPSG:${j.epsg}, 20 m, ${j.grid_width} by ${j.grid_height} pixels`);
    if (j.atmosphere) {
      const a = j.atmosphere;
      lines.push(`  Atmosphere    aerosol optical thickness ${a.pre_aot.toFixed(2)} pre, ${a.post_aot.toFixed(2)} post; water vapour ${a.pre_wvp.toFixed(2)} cm pre, ${a.post_wvp.toFixed(2)} cm post (Sen2Cor maps, reported only)`);
    }
    for (const w of j.warnings) lines.push(`  WARNING       ${w}`);
    for (const c of j.diagnostics) lines.push(`  ${c.severity === "warning" ? "CHECK        " : "Note         "} ${c.title}. ${c.detail} (${c.source})`);
    lines.push("");
    for (const d of j.deltas) {
      const unit = d.unit;
      const b = d.breaks_set;
      lines.push(`  ${d.id} (${d.direction})`);
      lines.push(`    Breaks      Low ${b.low}${unit}, Moderate ${b.moderate}${unit}, High ${b.high}${unit}`);
      const n = d.normalisation;
      if (n.method !== "median") {
        const used = d.breaks_used.low !== b.low
          ? `applied, classified on Low ${d.breaks_used.low.toFixed(3)}, Moderate ${d.breaks_used.moderate.toFixed(3)}, High ${d.breaks_used.high.toFixed(3)}`
          : n.applicable ? "measured but not applied, the switch was off" : `not applied, ${n.refusal}`;
        lines.push(`    Scene shift ${n.offset >= 0 ? "+" : ""}${n.offset.toFixed(3)} on unchanged ground, ${used}`);
      }
      const dflt = d.breaks_default;
      if (b.low !== dflt.low || b.moderate !== dflt.moderate || b.high !== dflt.high) {
        lines.push(`    DEVIATION   defaults were Low ${dflt.low}, Moderate ${dflt.moderate}, High ${dflt.high}`);
        lines.push(`    Justification ${state.justifications[d.id]?.trim() || "NOT PROVIDED"}`);
      } else {
        lines.push(`    Breaks source ${d.source}`);
      }
      lines.push(`    Histogram   ${d.analysis.shape}`);
      lines.push(`    Patches     ${d.patches_total} of moderate or high class`);
      lines.push("");
    }
  }

  if (state.climate && climateModule) {
    try {
      lines.push(...climateModule.climateRecord(state.climate, state.periods));
      lines.push("");
    } catch (error) {
      console.warn("climate record", error);
    }
  }
  if (state.corroboration) {
    lines.push(...state.corroboration.record);
    lines.push("");
  }
  const site = Object.entries(state.site);
  if (site.length) {
    lines.push("--- Site data ---");
    for (const [role, held] of site) lines.push(`  ${SITE_ROLES[role].label.padEnd(30)}${held.name}${held.labelField ? `, labelled by ${held.labelField}` : ""}`);
    lines.push("");
  }
  return lines.join("\n");
}

function renderRecord() {
  const text = buildRecord();
  $("record").textContent = text;
  $("record").hidden = !text;
  $("record-copy").disabled = !text;
  $("record-download").disabled = !text;
}

$("record-copy").onclick = async () => {
  try {
    await navigator.clipboard.writeText(buildRecord());
    $("record-copy").textContent = "Copied";
    setTimeout(() => ($("record-copy").textContent = "Copy"), 1500);
  } catch {
    showError("The browser would not copy. Select the text and copy it by hand.");
  }
};
$("record-download").onclick = () => download(buildRecord(), "text/plain", `run-record-${new Date().toISOString().slice(0, 10)}.txt`);

// ----------------------------------------------------------------- start

showSensor();
renderPeriods();
renderBreaksEditor();
renderSiteData();
renderRecord();
