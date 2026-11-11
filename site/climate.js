// Season at the site, ported from the disturbance checker, version 0.14.3.
//
// A pre and post delta only measures disturbance if the two composites were
// taken at the same point in the seasonal cycle of leaf greenness and sunlight.
// The SOP warns about this in words. This module puts the cycle on screen.
// It draws daily air temperature, sunlight, rain and snow at the site for every
// year the reporting periods touch. The windows are drawn over the top, so a
// mismatch is seen rather than remembered.
//
// The data is NASA POWER, the agency's daily surface climate service built on
// the MERRA-2 reanalysis. It answers anonymous requests with CORS, needs no
// key, and has served daily values since 1981. The grid is coarse, half a
// degree of latitude by five eighths of a degree of longitude. What comes back
// is the climate of the district, not the weather at the plot. That is the
// right resolution here, because the question is the timing of the season
// rather than any one day's conditions.
//
// None of this is an input to the analysis. It is context for a decision the
// tool leaves with the verifier.

const POWER_HOST = "power.larc.nasa.gov";

const POWER_DAILY = `https://${POWER_HOST}/api/temporal/daily/point`;

const POWER_ATTRIBUTION =
  "NASA POWER, daily surface climate from the MERRA-2 reanalysis, NASA Langley Research Center";

/** The value POWER writes where it has no observation. */
const FILL = -999;

/**
 * How many years of history to draw behind the reporting period years. Ten is
 * the shortest run over which a mean seasonal curve stops moving with any one
 * year.
 */
const REFERENCE_YEARS = 10;

/**
 * Length of the moving window the daily temperature and sunlight are smoothed
 * over. Seven days removes the day to day weather and leaves the season.
 */
const SMOOTHING_DAYS = 7;

/**
 * Rain is summed over the previous four weeks rather than smoothed. Leaf
 * greenness responds to the water that has arrived recently, not the rain on
 * the day.
 */
const RAIN_SUM_DAYS = 28;

/** Slots on the January to December axis, one per day of a leap year. */
const SLOTS_PER_YEAR = 366;

/** Month starts on the slot axis, for ticks. */
const MONTH_SLOTS = [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335];

const MONTH_LETTERS = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];

/** One colour per year, in the order the years are listed, readable on both themes. */
const YEAR_COLOURS = [
  "#58a6ff",
  "#f78166",
  "#3fb950",
  "#d2a8ff",
  "#e3b341",
  "#ff7b72",
  "#79c0ff",
  "#7ee787",
];

// Chart geometry, in pixels. The drawn width follows the container.
const DEFAULT_WIDTH = 260;
const HEIGHT = 74;
const PAD_LEFT = 24;
const PAD_RIGHT = 4;
const PAD_TOP = 10;
const PAD_BOTTOM = 12;

const SVG_NS = "http://www.w3.org/2000/svg";
const STYLE_ID = "clim-style";

/* Reading the data */

function pad(value) {
  return String(value).padStart(2, "0");
}

function keyFromIso(iso) {
  return iso.replace(/-/g, "");
}

function readValue(table, key) {
  const value = table ? table[key] : undefined;
  if (value === undefined || value === null) return null;
  if (!Number.isFinite(value) || value === FILL) return null;
  return value;
}

/** Every ISO date from start to end inclusive, in UTC arithmetic. */
function eachDay(start, end) {
  const out = [];
  const cursor = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (cursor.getTime() <= last.getTime()) {
    out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

/**
 * The years the reporting periods touch, and the range to fetch. The range
 * runs from ten years before the earliest year to the end of the latest.
 */
function climateRange(periods) {
  const years = new Set();
  for (const period of periods) {
    for (const date of [period.preStart, period.preEnd, period.postStart, period.postEnd]) {
      const year = Number.parseInt(String(date ?? "").slice(0, 4), 10);
      if (Number.isFinite(year)) years.add(year);
    }
  }
  const sorted = [...years].sort((a, b) => a - b);
  if (sorted.length === 0) sorted.push(new Date().getUTCFullYear());
  const first = sorted[0] - REFERENCE_YEARS;
  const last = sorted[sorted.length - 1];
  // POWER lags the present by a few days and rejects a future end date, so
  // the request never runs past today.
  const today = new Date().toISOString().slice(0, 10);
  const end = `${last}-12-31` < today ? `${last}-12-31` : today;
  return { years: sorted, start: `${first}-01-01`, end };
}

/** A key that changes only when a new request is worth making. */
function climateKey(longitude, latitude, start, end) {
  return `${longitude.toFixed(2)},${latitude.toFixed(2)},${start},${end}`;
}

/**
 * The climate service is a different host from the imagery, with a different
 * failure story. A blocked request names NASA POWER rather than the catalogue.
 */
function describeClimateError(error) {
  const message = error instanceof Error ? error.message : String(error ?? "Unknown error");
  if (/failed to fetch|networkerror|load failed/i.test(message)) {
    return "NASA POWER could not be reached. On a corporate network, power.larc.nasa.gov needs to be reachable over HTTPS.";
  }
  if (/\b429\b|too many requests/i.test(message)) {
    return "NASA POWER is rate limiting this connection. Wait a minute and try again.";
  }
  if (/\b5\d\d\b/.test(message)) {
    return `${message} This is a fault at NASA POWER rather than in the run parameters. Trying again shortly usually clears it.`;
  }
  return message;
}

async function fetchClimate(longitude, latitude, start, end) {
  const url = new URL(POWER_DAILY);
  url.searchParams.set("parameters", "T2M,T2M_MAX,T2M_MIN,PRECTOTCORR,ALLSKY_SFC_SW_DWN,SNODP");
  url.searchParams.set("community", "AG");
  url.searchParams.set("longitude", longitude.toFixed(4));
  url.searchParams.set("latitude", latitude.toFixed(4));
  url.searchParams.set("start", keyFromIso(start));
  url.searchParams.set("end", keyFromIso(end));
  url.searchParams.set("format", "JSON");

  // NASA POWER, daily surface climate from the MERRA-2 reanalysis, NASA Langley Research Center.
  // https://power.larc.nasa.gov/api/temporal/daily/point
  const response = await fetch(url.toString());
  if (!response.ok) {
    const status = `${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
    throw new Error(`NASA POWER answered ${status} for the climate request.`);
  }
  const body = await response.json();
  const table = body?.properties?.parameter;
  if (!table) {
    const detail = (body?.messages ?? []).join(" ") || "There was no parameter table in the response.";
    throw new Error(`NASA POWER returned no climate data. ${detail}`);
  }

  const days = eachDay(start, end).map((date) => {
    const key = keyFromIso(date);
    return {
      date,
      tMean: readValue(table.T2M, key),
      tMax: readValue(table.T2M_MAX, key),
      tMin: readValue(table.T2M_MIN, key),
      rain: readValue(table.PRECTOTCORR, key),
      sun: readValue(table.ALLSKY_SFC_SW_DWN, key),
      snow: readValue(table.SNODP, key),
    };
  });

  let lastObserved = null;
  for (let i = days.length - 1; i >= 0; i -= 1) {
    if (days[i].tMean !== null) {
      lastObserved = days[i].date;
      break;
    }
  }

  const coords = body?.geometry?.coordinates;
  return {
    latitude,
    longitude,
    elevation: coords && coords.length > 2 && Number.isFinite(coords[2]) ? coords[2] : null,
    start,
    end,
    days,
    lastObserved,
    fetchedAt: Date.now(),
  };
}

/** The last request, so asking again for the same place and years costs nothing. */
let held = null;

/**
 * Reads daily climate at a point for the years the reporting periods touch.
 *
 * The result is the checker's climate object, with latitude, longitude,
 * elevation, start, end, days, lastObserved and fetchedAt. Each day carries
 * date, tMean, tMax, tMin, rain, sun and snow, with null where POWER has no
 * value. A call for the same place and years as the last one returns the same
 * request rather than making a new one. A failed request throws an Error whose
 * message is written for the person at the screen.
 *
 * @param {number} lat Latitude of the centre of the project boundary, degrees.
 * @param {number} lon Longitude of the centre of the project boundary, degrees.
 * @param {Array<{id: string, preStart: string, preEnd: string, postStart: string, postEnd: string}>} periods
 */
export async function loadClimate(lat, lon, periods) {
  const latitude = Number(lat);
  const longitude = Number(lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new Error("The seasonal climate needs the centre of a project boundary, and none was given.");
  }
  const { start, end } = climateRange(periods ?? []);
  const key = climateKey(longitude, latitude, start, end);
  if (held && held.key === key) return held.promise;
  const promise = fetchClimate(longitude, latitude, start, end).catch((error) => {
    if (held && held.promise === promise) held = null;
    throw new Error(describeClimateError(error), { cause: error });
  });
  held = { key, promise };
  return promise;
}

/* Derived series */

/**
 * Position of a date on a January to December axis, 0 to 365. Every month and
 * day lands on the same slot whatever the year. The axis follows a leap year,
 * so in other years the 29 February slot is left empty and the line crosses it.
 */
function dayOfYearSlot(iso) {
  const month = Number.parseInt(iso.slice(5, 7), 10);
  const day = Number.parseInt(iso.slice(8, 10), 10);
  return MONTH_SLOTS[month - 1] + day - 1;
}

/**
 * Centred moving mean of a metric, or for rain the sum over the previous days.
 * Nulls are skipped. A window with fewer than half its days present is itself
 * null, so a gap in the record shows as a gap rather than as a value.
 */
function smooth(days, metric, width, mode) {
  const out = new Array(days.length).fill(null);
  const half = Math.floor(width / 2);
  for (let i = 0; i < days.length; i += 1) {
    // Rain looks back, the others look around.
    const from = mode === "sum" ? i - width + 1 : i - half;
    const to = mode === "sum" ? i : i + half;
    let total = 0;
    let count = 0;
    for (let j = Math.max(0, from); j <= Math.min(days.length - 1, to); j += 1) {
      const value = days[j][metric];
      if (value === null) continue;
      total += value;
      count += 1;
    }
    if (count < Math.ceil(width / 2)) continue;
    out[i] = mode === "sum" ? total : total / count;
  }
  return out;
}

/** The smoothed metric split by year on the slot axis, one line per year. */
function linesByYear(days, smoothed, years) {
  const wanted = new Set(years);
  const lines = new Map();
  for (let i = 0; i < days.length; i += 1) {
    const year = Number.parseInt(days[i].date.slice(0, 4), 10);
    if (!wanted.has(year)) continue;
    let line = lines.get(year);
    if (!line) {
      line = new Array(SLOTS_PER_YEAR).fill(null);
      lines.set(year, line);
    }
    line[dayOfYearSlot(days[i].date)] = smoothed[i];
  }
  return years.filter((year) => lines.has(year)).map((year) => ({ year, values: lines.get(year) }));
}

/**
 * The mean over every fetched year, slot by slot, of the smoothed metric. This
 * is the grey reference curve the period years are read against.
 */
function referenceLine(days, smoothed) {
  const totals = new Array(SLOTS_PER_YEAR).fill(0);
  const counts = new Array(SLOTS_PER_YEAR).fill(0);
  for (let i = 0; i < days.length; i += 1) {
    const value = smoothed[i];
    if (value === null) continue;
    const slot = dayOfYearSlot(days[i].date);
    totals[slot] += value;
    counts[slot] += 1;
  }
  return totals.map((total, slot) => (counts[slot] >= 2 ? total / counts[slot] : null));
}

/* Window statistics */

function mean(values) {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** What the climate did inside one composite window. */
function windowClimate(series, start, end) {
  const inside = series.days.filter((day) => day.date >= start && day.date <= end);
  const present = (key) =>
    inside.map((day) => day[key]).filter((value) => typeof value === "number");
  const rain = present("rain");
  const snow = present("snow");
  return {
    start,
    end,
    observed: present("tMean").length,
    length: eachDay(start, end).length,
    tMean: mean(present("tMean")),
    sun: mean(present("sun")),
    rain: rain.length > 0 ? rain.reduce((a, b) => a + b, 0) : null,
    snow: mean(snow),
    snowDays: snow.filter((depth) => depth > 0).length,
  };
}

function periodClimates(series, periods) {
  return periods.map((period) => ({
    periodId: period.id,
    pre: windowClimate(series, period.preStart, period.preEnd),
    post: windowClimate(series, period.postStart, period.postEnd),
  }));
}

/** The distinct month and day spans the windows cover, for shading. */
function windowSpans(periods) {
  const seen = new Map();
  for (const period of periods) {
    for (const [label, start, end] of [
      ["pre", period.preStart, period.preEnd],
      ["post", period.postStart, period.postEnd],
    ]) {
      const from = dayOfYearSlot(String(start ?? ""));
      const to = dayOfYearSlot(String(end ?? ""));
      if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
      const key = `${from}-${to}`;
      const kept = seen.get(key);
      if (kept) {
        if (!kept.label.includes(label)) kept.label = `${kept.label} and ${label}`;
      } else {
        seen.set(key, { label, from, to });
      }
    }
  }
  return [...seen.values()];
}

/** Whether any day in the record had snow on the ground. */
function hasSnow(series) {
  return series.days.some((day) => (day.snow ?? 0) > 0);
}

function formatMonthDay(slot) {
  let month = 0;
  while (month < 11 && MONTH_SLOTS[month + 1] <= slot) month += 1;
  return `${pad(month + 1)}-${pad(slot - MONTH_SLOTS[month] + 1)}`;
}

function show(value, digits) {
  return value === null ? "-" : value.toFixed(digits);
}

/* Run record */

/**
 * The "Season at the site" block of the run record, as plain text lines. It
 * gives the source, the point and range read, and the pre and post climate of
 * every period, so a finding can quote them. It returns an empty array when
 * there is no climate to report.
 */
export function climateRecord(climate, periods) {
  if (!climate || !Array.isArray(climate.days)) return [];
  const lines = [];
  lines.push("--- Season at the site ---");
  lines.push(`  Source        ${POWER_ATTRIBUTION}`);
  lines.push(
    `  Read at       ${climate.latitude.toFixed(3)}, ${climate.longitude.toFixed(3)}, ${climate.start} to ${climate.end}, half-degree grid cell`,
  );
  const line = (label, w) =>
    `  ${label.padEnd(14)}${w.start} to ${w.end}, mean ${show(w.tMean, 1)} C, sun ${show(w.sun, 1)} MJ/m2/day, rain ${show(w.rain, 0)} mm, snow ${w.snowDays} of ${w.length} days${w.observed < w.length ? ` (${w.observed} days observed)` : ""}`;
  for (const entry of periodClimates(climate, periods ?? [])) {
    lines.push(`  ${entry.periodId}`);
    lines.push(line("  Pre", entry.pre));
    lines.push(line("  Post", entry.post));
  }
  lines.push(
    "  Note          the climate is context for placing the windows and is not an input to the analysis",
  );
  lines.push("");
  return lines;
}

/* Drawing */

const STYLE = `
.clim-block { display: flex; flex-direction: column; gap: 8px; padding: 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); color: var(--ink); }
.clim-label { margin: 0; font-size: 14px; font-weight: 600; color: var(--ink); }
.clim-legend { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 12px; }
.clim-legend-item { display: flex; align-items: center; gap: 5px; }
.clim-chip { width: 11px; height: 11px; border: 1px solid var(--line); border-radius: 2px; flex: none; }
.clim-chip-mean { background: var(--muted); opacity: 0.55; }
.clim-chip-window { background: var(--accent); opacity: 0.5; }
.clim-chart-wrap { display: block; width: 100%; min-height: ${HEIGHT}px; }
.clim-chart { display: block; width: 100%; height: ${HEIGHT}px; overflow: visible; touch-action: pan-y; }
.clim-window { fill: var(--accent); fill-opacity: 0.14; }
.clim-axis { stroke: var(--line); stroke-width: 1; }
.clim-zero { stroke: var(--muted); stroke-width: 1; stroke-dasharray: 1 3; }
.clim-reference { fill: none; stroke: var(--muted); stroke-width: 2.25; stroke-opacity: 0.45; stroke-linejoin: round; }
.clim-line { fill: none; stroke-width: 1.25; stroke-linejoin: round; }
.clim-cursor { stroke: var(--ink); stroke-width: 0.75; stroke-opacity: 0.6; pointer-events: none; }
.clim-tick, .clim-readout { fill: var(--muted); font-size: 7px; }
.clim-readout { fill: var(--ink); font-variant-numeric: tabular-nums; }
.clim-title { fill: var(--ink); font-size: 7.5px; font-weight: 600; }
.clim-stack { display: flex; flex-direction: column; gap: 6px; }
.clim-table { width: 100%; border-collapse: collapse; font-size: 12px; font-variant-numeric: tabular-nums; }
.clim-table caption { padding: 2px 4px; color: var(--muted); font-weight: 600; text-align: left; caption-side: top; }
.clim-table th, .clim-table td { padding: 3px 4px; text-align: right; }
.clim-table th { color: var(--muted); font-weight: 500; }
.clim-table th:first-child, .clim-table td:first-child { color: var(--muted); text-align: left; }
.clim-hint { margin: 0; color: var(--muted); font-size: 12px; line-height: 1.4; }
.clim-attribution { font-size: 11px; }
.clim-notice { padding: 8px 10px; border: 1px solid var(--warn-line); border-radius: 6px; background: var(--warn-bg); color: var(--ink); font-size: 13px; }
.clim-notice-title { margin-bottom: 3px; font-weight: 600; }
.clim-status { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 13px; }
.clim-spinner { width: 10px; height: 10px; flex: none; border: 2px solid var(--line); border-top-color: var(--accent); border-radius: 50%; animation: clim-spin 0.9s linear infinite; }
@keyframes clim-spin { to { transform: rotate(360deg); } }
`;

/** Adds the module's style element to the page once. */
function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = STYLE;
  document.head.appendChild(style);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

function yearColour(index) {
  return YEAR_COLOURS[index % YEAR_COLOURS.length];
}

/**
 * One metric on a January to December axis. Every reporting period year is its
 * own line over a grey long run mean, with the composite windows shaded. The
 * chart answers whether the pre and post windows sit at the same point of the
 * season, and whether the season ran early or late in either year.
 */
function drawChart(options, width) {
  const { lines, reference, spans, floorAtZero } = options;
  const WIDTH = Math.max(160, Math.round(width));

  // The viewBox matches the drawn width, so the text is never stretched.
  const svg = svgEl("svg", {
    class: "clim-chart",
    viewBox: `0 0 ${WIDTH} ${HEIGHT}`,
    preserveAspectRatio: "xMinYMin meet",
    role: "img",
    "aria-label": `${options.title}, ${options.unit}, by day of year`,
  });

  const plotWidth = WIDTH - PAD_LEFT - PAD_RIGHT;
  const plotHeight = HEIGHT - PAD_TOP - PAD_BOTTOM;

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  const consider = (value) => {
    if (value === null) return;
    if (value < min) min = value;
    if (value > max) max = value;
  };
  reference.forEach(consider);
  for (const line of lines) line.values.forEach(consider);
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    min = 0;
    max = 1;
  }
  if (floorAtZero) min = Math.min(0, min);
  if (max - min < 1e-6) max = min + 1;
  // A little headroom so the top of a line is not clipped by the title.
  const span = (max - min) * 1.05;

  const toX = (slot) => PAD_LEFT + (slot / (SLOTS_PER_YEAR - 1)) * plotWidth;
  const toY = (value) => PAD_TOP + plotHeight - ((value - min) / span) * plotHeight;

  // Windows first, so every line is drawn over them.
  for (const band of spans) {
    const x1 = toX(Math.min(band.from, band.to));
    const x2 = toX(Math.max(band.from, band.to));
    svg.appendChild(
      svgEl("rect", {
        x: x1,
        y: PAD_TOP,
        width: Math.max(1, x2 - x1),
        height: plotHeight,
        class: "clim-window",
      }),
    );
  }

  // Axes.
  svg.appendChild(
    svgEl("line", {
      x1: PAD_LEFT,
      y1: PAD_TOP + plotHeight,
      x2: WIDTH - PAD_RIGHT,
      y2: PAD_TOP + plotHeight,
      class: "clim-axis",
    }),
  );
  if (min < 0 && max > 0) {
    svg.appendChild(
      svgEl("line", {
        x1: PAD_LEFT,
        y1: toY(0),
        x2: WIDTH - PAD_RIGHT,
        y2: toY(0),
        class: "clim-zero",
      }),
    );
  }
  for (let month = 0; month < 12; month += 1) {
    const x = toX(MONTH_SLOTS[month]);
    svg.appendChild(
      svgEl("line", {
        x1: x,
        y1: PAD_TOP + plotHeight,
        x2: x,
        y2: PAD_TOP + plotHeight + 2,
        class: "clim-axis",
      }),
    );
    const label = svgEl("text", {
      x: toX(MONTH_SLOTS[month] + 15),
      y: HEIGHT - 3,
      class: "clim-tick",
      "text-anchor": "middle",
    });
    label.textContent = MONTH_LETTERS[month];
    svg.appendChild(label);
  }

  const yLabel = (value, y, anchor) => {
    const label = svgEl("text", {
      x: PAD_LEFT - 3,
      y,
      class: "clim-tick",
      "text-anchor": "end",
      "dominant-baseline": anchor,
    });
    label.textContent = value.toFixed(options.digits > 0 && Math.abs(value) < 10 ? 1 : 0);
    svg.appendChild(label);
  };
  yLabel(max, PAD_TOP, "hanging");
  yLabel(min, PAD_TOP + plotHeight, "auto");

  const pathFor = (values) => {
    let d = "";
    let pen = false;
    for (let slot = 0; slot < values.length; slot += 1) {
      const value = values[slot];
      if (value === null) {
        pen = false;
        continue;
      }
      d += `${pen ? "L" : "M"}${toX(slot).toFixed(1)} ${toY(value).toFixed(1)} `;
      pen = true;
    }
    return d.trim();
  };

  svg.appendChild(svgEl("path", { d: pathFor(reference), class: "clim-reference" }));
  lines.forEach((line, index) => {
    svg.appendChild(
      svgEl("path", { d: pathFor(line.values), class: "clim-line", stroke: yearColour(index) }),
    );
  });

  // Title.
  const title = svgEl("text", { x: PAD_LEFT, y: 7, class: "clim-title" });
  title.textContent = `${options.title}, ${options.unit}`;
  svg.appendChild(title);

  // Hover readout, the date and every line's value at the pointer.
  const cursor = svgEl("line", {
    x1: 0,
    y1: PAD_TOP,
    x2: 0,
    y2: PAD_TOP + plotHeight,
    class: "clim-cursor",
    visibility: "hidden",
  });
  svg.appendChild(cursor);
  const readout = svgEl("text", {
    x: WIDTH - PAD_RIGHT,
    y: 7,
    class: "clim-readout",
    "text-anchor": "end",
  });
  svg.appendChild(readout);

  const hide = () => {
    cursor.setAttribute("visibility", "hidden");
    readout.textContent = "";
  };
  svg.addEventListener("pointermove", (event) => {
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0) return;
    const x = ((event.clientX - rect.left) / rect.width) * WIDTH;
    const slot = Math.round(((x - PAD_LEFT) / plotWidth) * (SLOTS_PER_YEAR - 1));
    if (slot < 0 || slot >= SLOTS_PER_YEAR) {
      hide();
      return;
    }
    cursor.setAttribute("x1", String(toX(slot)));
    cursor.setAttribute("x2", String(toX(slot)));
    cursor.setAttribute("visibility", "visible");
    const parts = lines.map((line) => {
      const value = line.values[slot];
      return `${line.year} ${value === null ? "-" : value.toFixed(options.digits)}`;
    });
    const ref = reference[slot];
    parts.push(`mean ${ref === null ? "-" : ref.toFixed(options.digits)}`);
    readout.textContent = `${formatMonthDay(slot)}  ${parts.join("  ")}`;
  });
  svg.addEventListener("pointerleave", hide);

  return svg;
}

/** Width watchers per container, so drawing again stops the old ones. */
const watchers = new WeakMap();

/**
 * Adds a chart that follows the width of the element holding it. The chart is
 * drawn at the width it is given and drawn again when that width changes.
 */
function mountChart(parent, options, observers) {
  const wrap = el("div", "clim-chart-wrap");
  parent.appendChild(wrap);
  let drawnAt = 0;
  const draw = (width) => {
    const target = width > 0 ? width : DEFAULT_WIDTH;
    if (Math.abs(target - drawnAt) < 4) return;
    drawnAt = target;
    wrap.replaceChildren(drawChart(options, target));
  };
  draw(wrap.clientWidth);
  if (typeof ResizeObserver !== "undefined") {
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) draw(entry.contentRect.width);
    });
    observer.observe(wrap);
    observers.push(observer);
  }
}

function notice(title, detail) {
  const box = el("div", "clim-notice");
  box.setAttribute("role", "status");
  box.appendChild(el("div", "clim-notice-title", title));
  box.appendChild(el("div", "", detail));
  return box;
}

/**
 * Pre against post, per period, as the numbers a finding can quote. No
 * threshold is applied. What counts as a large difference depends on the
 * forest, and a verifier reads it against the curves above.
 */
function renderTable(series, periods) {
  const wrap = el("div", "clim-stack");
  const rows = [
    { label: "Mean temperature, °C", read: (w) => w.tMean, digits: 1 },
    { label: "Sunlight, MJ/m² a day", read: (w) => w.sun, digits: 1 },
    { label: "Rain over the window, mm", read: (w) => w.rain, digits: 0 },
    { label: "Days with snow cover", read: (w) => w.snowDays, digits: 0 },
  ];

  for (const entry of periodClimates(series, periods)) {
    const table = el("table", "clim-table");
    table.appendChild(
      el(
        "caption",
        "",
        `${entry.periodId}, pre ${entry.pre.start} to ${entry.pre.end}, post ${entry.post.start} to ${entry.post.end}`,
      ),
    );
    const head = el("thead");
    const header = el("tr");
    for (const text of ["", "Pre", "Post", "Post minus pre"]) header.appendChild(el("th", "", text));
    head.appendChild(header);
    table.appendChild(head);
    const body = el("tbody");
    for (const row of rows) {
      const tr = el("tr");
      tr.appendChild(el("td", "", row.label));
      const pre = row.read(entry.pre);
      const post = row.read(entry.post);
      tr.appendChild(el("td", "", show(pre, row.digits)));
      tr.appendChild(el("td", "", show(post, row.digits)));
      const diff = pre !== null && post !== null ? post - pre : null;
      tr.appendChild(
        el("td", "", diff === null ? "-" : `${diff > 0 ? "+" : ""}${diff.toFixed(row.digits)}`),
      );
      body.appendChild(tr);
    }
    table.appendChild(body);
    wrap.appendChild(table);

    for (const [name, w] of [
      ["pre", entry.pre],
      ["post", entry.post],
    ]) {
      if (w.observed < w.length) {
        wrap.appendChild(
          el(
            "p",
            "clim-hint",
            `The ${name} window of ${entry.periodId} has climate for ${w.observed} of its ${w.length} days. NASA POWER runs a few days behind the present, and a window in the future has none.`,
          ),
        );
      }
    }
  }
  return wrap;
}

function renderSeries(block, series, periods, observers) {
  const { years } = climateRange(periods);
  const spans = windowSpans(periods);

  const legend = el("div", "clim-legend");
  years.forEach((year, index) => {
    const item = el("span", "clim-legend-item");
    const chip = el("span", "clim-chip");
    chip.style.background = yearColour(index);
    item.appendChild(chip);
    item.appendChild(el("span", "", String(year)));
    legend.appendChild(item);
  });
  const meanItem = el("span", "clim-legend-item");
  meanItem.appendChild(el("span", "clim-chip clim-chip-mean"));
  meanItem.appendChild(el("span", "", `${series.start.slice(0, 4)} to ${series.end.slice(0, 4)} mean`));
  legend.appendChild(meanItem);
  if (spans.length > 0) {
    const windowItem = el("span", "clim-legend-item");
    windowItem.appendChild(el("span", "clim-chip clim-chip-window"));
    windowItem.appendChild(el("span", "", spans.map((band) => `${band.label} window`).join(", ")));
    legend.appendChild(windowItem);
  }
  block.appendChild(legend);

  const chart = (metric, title, unit, width, mode, floorAtZero, digits) => {
    const smoothed = smooth(series.days, metric, width, mode);
    mountChart(
      block,
      {
        title,
        unit,
        lines: linesByYear(series.days, smoothed, years),
        reference: referenceLine(series.days, smoothed),
        spans,
        floorAtZero,
        digits,
      },
      observers,
    );
  };

  chart("tMean", "Air temperature", "°C, 7-day mean", SMOOTHING_DAYS, "mean", false, 1);
  chart("sun", "Sunlight", "MJ/m² a day, 7-day mean", SMOOTHING_DAYS, "mean", true, 1);
  chart("rain", "Rain", "mm over the previous 28 days", RAIN_SUM_DAYS, "sum", true, 0);
  if (hasSnow(series)) {
    chart("snow", "Snow depth", "cm, 7-day mean", SMOOTHING_DAYS, "mean", true, 0);
  }

  block.appendChild(renderTable(series, periods));

  block.appendChild(
    el(
      "p",
      "clim-hint",
      "Hover a chart to read the values. The shaded bands are the composite windows, and they should sit on the same part of every curve. A coloured line running above the grey mean in spring is a season that came early, so the leaves were further on than the calendar date says. A line running below it is a late season. A window with snow on the ground in one year and not the other is not a matched pair whatever the dates.",
    ),
  );

  const where = `${Math.abs(series.latitude).toFixed(2)}° ${series.latitude >= 0 ? "N" : "S"}, ${Math.abs(series.longitude).toFixed(2)}° ${series.longitude >= 0 ? "E" : "W"}`;
  const height = series.elevation !== null ? `, ${Math.round(series.elevation)} m` : "";
  const observed = series.lastObserved
    ? `Observed to ${series.lastObserved}.`
    : "No observations were returned for this range.";
  block.appendChild(
    el(
      "p",
      "clim-hint clim-attribution",
      `${POWER_ATTRIBUTION}, read at ${where}${height}. The grid cell is about fifty kilometres across, so this is the season of the district rather than the weather at the plot. The grey line is the mean of the ${REFERENCE_YEARS} years before the earliest period year and the period years themselves. ${observed}`,
    ),
  );
}

/**
 * Draws "Season at the site" into the container, replacing its contents.
 *
 * Given the climate object from loadClimate, it draws the legend, the four
 * charts and a pre and post table for every period. It also takes three other
 * values for the states around a request. The string "loading" draws a
 * waiting line, an Error draws a warning with its message, and null draws a
 * prompt to set a project boundary.
 */
export function renderClimate(container, climate, periods) {
  if (!container) return;
  injectStyle();
  for (const observer of watchers.get(container) ?? []) observer.disconnect();
  const observers = [];
  watchers.set(container, observers);
  container.replaceChildren();

  const block = el("div", "clim-block");
  block.appendChild(el("h3", "clim-label", "Season at the site"));
  container.appendChild(block);

  if (climate === "loading") {
    const line = el("div", "clim-status");
    line.appendChild(el("span", "clim-spinner"));
    line.appendChild(el("span", "", "Reading daily climate from NASA POWER."));
    block.appendChild(line);
    return;
  }

  if (climate instanceof Error) {
    block.appendChild(
      notice(
        "The seasonal climate could not be read",
        `${climate.message || "No data came back."} The windows can still be set and the run does not depend on it.`,
      ),
    );
    return;
  }

  if (!climate || !Array.isArray(climate.days)) {
    block.appendChild(
      el(
        "p",
        "clim-hint",
        "Set a project boundary and the seasonal climate at its centre is drawn here, with the pre and post windows shaded over it.",
      ),
    );
    return;
  }

  renderSeries(block, climate, periods ?? [], observers);
}
