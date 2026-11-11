// The page: the map, the boundary, the settings and the results.
// The check itself runs in Rust, in worker.js.
"use strict";

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------ map

const map = L.map("map", { zoomControl: true }).setView([44.0, -122.5], 9);
const imagery = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
  maxZoom: 19,
  attribution: "Imagery &copy; Esri, Maxar, Earthstar Geographics",
}).addTo(map);
const streets = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors",
});
L.control.layers({ "Satellite imagery": imagery, "Street map": streets }, null, { position: "topright" }).addTo(map);
L.control.scale({ imperial: false }).addTo(map);
map.pm.setGlobalOptions({ pathOptions: { color: "#ffd400", weight: 2, fillOpacity: 0.05 } });

// ------------------------------------------------------------- boundary

let aoi = null; // { kind: "rectangle", bbox } or { kind: "geojson", geometry }
let aoiLayer = null;

function setAoi(next, layer, label) {
  if (aoiLayer) map.removeLayer(aoiLayer);
  aoi = next;
  aoiLayer = layer;
  if (layer) {
    layer.addTo(map);
    map.fitBounds(layer.getBounds(), { padding: [20, 20] });
  }
  $("aoi-status").textContent = label;
  $("run").disabled = !aoi;
}

map.on("pm:create", (event) => {
  const layer = event.layer;
  map.removeLayer(layer);
  const style = { color: "#ffd400", weight: 2, fill: false };
  if (event.shape === "Rectangle") {
    const b = layer.getBounds();
    setAoi({ kind: "rectangle", bbox: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()] }, L.rectangle(b, style), "Rectangle drawn.");
  } else {
    const geometry = layer.toGeoJSON();
    setAoi({ kind: "geojson", geometry }, L.geoJSON(geometry, { style }), "Polygon drawn.");
  }
});

$("draw-rect").onclick = () => map.pm.enableDraw("Rectangle");
$("draw-poly").onclick = () => map.pm.enableDraw("Polygon", { finishOn: "dblclick" });
$("upload").onclick = () => $("file").click();

$("file").onchange = async () => {
  const file = $("file").files[0];
  $("file").value = "";
  if (!file) return;
  try {
    let geometry;
    const name = file.name.toLowerCase();
    if (name.endsWith(".zip")) {
      geometry = await shp(await file.arrayBuffer());
      if (Array.isArray(geometry)) geometry = { type: "FeatureCollection", features: geometry.flatMap((c) => c.features) };
    } else if (name.endsWith(".kml")) {
      geometry = toGeoJSON.kml(new DOMParser().parseFromString(await file.text(), "text/xml"));
    } else {
      geometry = JSON.parse(await file.text());
    }
    const layer = L.geoJSON(geometry, { style: { color: "#ffd400", weight: 2, fill: false } });
    if (!layer.getLayers().length) throw new Error("The file holds no shapes.");
    const polygons = countPolygons(geometry);
    if (!polygons) throw new Error("The file holds no polygons, only points or lines.");
    setAoi({ kind: "geojson", geometry }, layer, `${file.name}: ${polygons} polygon${polygons === 1 ? "" : "s"}.`);
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

// ------------------------------------------------------------------ run

let worker = null;
let started = 0;

function showError(message) {
  $("error").textContent = message;
  $("error").hidden = !message;
}

function stop() {
  if (worker) worker.terminate();
  worker = null;
  $("progress-box").hidden = true;
  $("run").disabled = !aoi;
}

$("cancel").onclick = stop;

$("run").onclick = () => {
  if (!aoi) return;
  showError("");
  const params = {
    aoi,
    pre_start: $("pre-start").value,
    pre_end: $("pre-end").value,
    post_start: $("post-start").value,
    post_end: $("post-end").value,
    host: $("host").value,
    normalise: $("shift").checked,
    max_cloud: Number($("cloud").value) || 30,
    mask: { reject_cast_shadow: $("cast").checked, reject_snow: $("snow").checked },
    concurrency: 12,
    coarse_read: $("coarse").checked,
  };
  if (!(params.pre_start < params.pre_end && params.post_start < params.post_end)) {
    showError("Each window's start date must come before its end date.");
    return;
  }
  stop();
  $("run").disabled = true;
  $("progress-box").hidden = false;
  $("progress").value = 0;
  $("progress-text").textContent = "Starting";
  started = performance.now();
  worker = new Worker("worker.js", { type: "module" });
  worker.onmessage = (event) => {
    const m = event.data;
    if (m.type === "progress") {
      $("progress").value = m.fraction;
      const seconds = ((performance.now() - started) / 1000).toFixed(0);
      $("progress-text").textContent = `${m.message}, ${seconds} s`;
    } else if (m.type === "done") {
      const seconds = (performance.now() - started) / 1000;
      stop();
      showResults(JSON.parse(m.json), m.png, params, seconds);
    } else if (m.type === "error") {
      stop();
      showError(m.message);
    }
  };
  worker.onerror = (event) => {
    stop();
    showError(`The check stopped unexpectedly. ${event.message || ""}`);
  };
  worker.postMessage(params);
};

// -------------------------------------------------------------- results

let overlays = [];
let highlight = null;
let lastResult = null;
let lastParams = null;
let activeDelta = "dNDVI";

const CLASS_NAMES = { 2: "Moderate", 3: "High" };
const PALETTES = {
  dNDVI: ["#FFEDA0", "#FC4E2A", "#800026"],
  dNDMI: ["#FEB24C", "#FD8D3C", "#B10026"],
  dNBR: ["#FFEDA0", "#FC4E2A", "#800026"],
};

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

function showResults(result, pngs, params, seconds) {
  lastResult = result;
  lastParams = params;
  for (const o of overlays) map.removeLayer(o.layer);
  overlays = [];
  if (highlight) map.removeLayer(highlight);

  const s = result.stats;
  $("summary").innerHTML =
    `<p>Finished in ${seconds.toFixed(1)} s from ${escapeHtml(result.host)}. ` +
    `Downloaded ${(s.bytes / 1e6).toFixed(0)} MB in ${s.requests} requests. ` +
    `${result.pre.length} views before and ${result.post.length} after.</p>`;
  $("warnings").innerHTML = result.warnings.map((w) => `<div class="note">${escapeHtml(w)}</div>`).join("");

  // Layers, top of the list drawn on top.
  const opacity = Number($("opacity").value);
  $("layers").innerHTML = "";
  result.layers.forEach((layer, i) => {
    const [w, south, e, n] = layer.bounds;
    const url = URL.createObjectURL(new Blob([pngs[i]], { type: "image/png" }));
    const overlay = L.imageOverlay(url, [[south, w], [n, e]], { opacity, className: "pixelated", interactive: false });
    const visible = layer.key === "dNDVI";
    if (visible) overlay.addTo(map);
    const entry = { key: layer.key, layer: overlay, box: null };
    overlays.push(entry);
    const palette = PALETTES[layer.key];
    const legend = palette
      ? ["Low", "Moderate", "High"].map((name, k) => `<span class="swatch" style="background:${palette[k]}"></span>${name}`).join(" ")
      : "";
    const row = document.createElement("label");
    row.className = "layer";
    row.innerHTML = `<input type="checkbox" ${visible ? "checked" : ""}> ${escapeHtml(layer.name)} <span class="legend">${legend}</span>`;
    entry.box = row.querySelector("input");
    entry.box.onchange = (event) => {
      if (event.target.checked) overlay.addTo(map);
      else map.removeLayer(overlay);
      keepTrueColourBelow();
    };
    $("layers").appendChild(row);
  });
  if (aoiLayer) aoiLayer.bringToFront();

  // Thresholds.
  $("breaks").innerHTML =
    `<table><thead><tr><th>Index</th><th class="num">Low</th><th class="num">Moderate</th><th class="num">High</th><th>Shift</th></tr></thead><tbody>` +
    result.deltas
      .map((d) => {
        const shifted = d.breaks_used.low !== d.breaks_default.low;
        const shift = shifted ? `${d.normalisation.offset >= 0 ? "+" : ""}${d.normalisation.offset.toFixed(3)}` : "none";
        const title = d.normalisation.refusal ? ` title="${escapeHtml(d.normalisation.refusal)}"` : "";
        return `<tr><td>${d.id}, ${escapeHtml(d.meaning)}</td><td class="num">${d.breaks_used.low.toFixed(3)}</td><td class="num">${d.breaks_used.moderate.toFixed(3)}</td><td class="num">${d.breaks_used.high.toFixed(3)}</td><td${title}>${shift}</td></tr>`;
      })
      .join("") +
    `</tbody></table><div class="muted">SOP defaults are dNDVI 0.10, 0.20, 0.35; dNDMI 0.15, 0.30, 0.45; dNBR 0.10, 0.27, 0.44. A shift is applied only when at least half the pixels sit within 0.05 of the unchanged peak.</div>`;

  // Views.
  const list = (views) =>
    `<ul class="plain">${views.map((v) => `<li>${v.date}, ${v.cloud_cover.toFixed(0)} per cent cloud, tile ${escapeHtml(v.tiles.join(" and "))}</li>`).join("")}</ul>`;
  $("views").innerHTML = `<div>Before, ${params.pre_start} to ${params.pre_end}</div>${list(result.pre)}<div>After, ${params.post_start} to ${params.post_end}</div>${list(result.post)}`;

  // Patch table.
  $("tabs").innerHTML = "";
  for (const d of result.deltas) {
    const b = document.createElement("button");
    b.textContent = `${d.id} (${d.patches_total})`;
    b.setAttribute("aria-pressed", String(d.id === activeDelta));
    b.onclick = () => {
      activeDelta = d.id;
      for (const other of $("tabs").children) other.setAttribute("aria-pressed", String(other === b));
      showPatches();
    };
    $("tabs").appendChild(b);
  }
  showPatches();

  $("results").hidden = false;
}

// The true-colour pictures sit under the class layers.
function keepTrueColourBelow() {
  for (const o of overlays) if (!PALETTES[o.key] && map.hasLayer(o.layer)) o.layer.bringToBack();
}

function showPatches() {
  const result = lastResult;
  const d = result.deltas.find((x) => x.id === activeDelta);
  const rows = result.patches.filter((p) => p.delta === activeDelta);
  if (!rows.length) {
    $("patches").innerHTML = `<p class="muted">No moderate or high patches on ${activeDelta}.</p>`;
    return;
  }
  const more = d.patches_total > rows.length ? `<div class="muted">The first ${rows.length} of ${d.patches_total} are listed; the CSV holds the same rows.</div>` : "";
  $("patches").innerHTML =
    `<table><thead><tr><th>Class</th><th class="num">Latitude</th><th class="num">Longitude</th><th class="num">Peak ${activeDelta}</th></tr></thead><tbody>` +
    rows
      .map((p, i) => `<tr class="click" data-i="${i}"><td><span class="swatch" style="background:${PALETTES[p.delta][p.class - 1]}"></span>${CLASS_NAMES[p.class]}</td><td class="num">${p.lat.toFixed(5)}</td><td class="num">${p.lon.toFixed(5)}</td><td class="num">${p.peak.toFixed(3)}</td></tr>`)
      .join("") +
    `</tbody></table>${more}`;
  for (const tr of $("patches").querySelectorAll("tr.click")) {
    tr.onclick = () => {
      const p = rows[Number(tr.dataset.i)];
      const [w, s, e, n] = p.bounds;
      if (highlight) map.removeLayer(highlight);
      highlight = L.rectangle([[s, w], [n, e]], { color: "#00e5ff", weight: 2, fill: false }).addTo(map);
      map.fitBounds(highlight.getBounds(), { maxZoom: 16, padding: [60, 60] });
      for (const o of overlays) {
        if (o.key === p.delta && !map.hasLayer(o.layer)) {
          o.layer.addTo(map);
          o.box.checked = true;
          keepTrueColourBelow();
        }
      }
    };
  }
}

$("opacity").oninput = () => {
  for (const o of overlays) o.layer.setOpacity(Number($("opacity").value));
};

$("csv").onclick = () => {
  if (!lastResult) return;
  const p = lastParams;
  const meaning = Object.fromEntries(lastResult.deltas.map((d) => [d.id, d.meaning]));
  const lines = ["delta,meaning,class,latitude,longitude,peak_value,pre_window,post_window"];
  for (const r of lastResult.patches) {
    lines.push([r.delta, meaning[r.delta], CLASS_NAMES[r.class].toLowerCase(), r.lat.toFixed(6), r.lon.toFixed(6), r.peak.toFixed(3), `${p.pre_start}/${p.pre_end}`, `${p.post_start}/${p.post_end}`].join(","));
  }
  const url = URL.createObjectURL(new Blob([lines.join("\n") + "\n"], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `flagged-patches-${p.post_start}.csv`;
  a.click();
  URL.revokeObjectURL(url);
};
