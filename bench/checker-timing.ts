// Times one Sentinel-2 period of the checker, split into network, decode and arithmetic.
// Imports the checker's own modules unchanged from disturbance-checker-srm 0.14.3.
// Build and run from this folder, with the checker cloned beside this repository:
//   ../../disturbance-checker-srm/node_modules/.bin/esbuild checker-timing.ts --bundle --platform=node --format=esm --outfile=out/checker-timing.mjs
//   node out/checker-timing.mjs 25600
import { runPeriod, assetsFor, BLOCK_SIZE, type RunParams, type Period } from "../../disturbance-checker-srm/src/analysis/run";
import { DELTAS, CLASS_PALETTES, RGB_VIS, type OpticalDeltaId } from "../../disturbance-checker-srm/src/defaults";
import { searchScenes, bestEpsgFor, observationsOnGrid, type Observation } from "../../disturbance-checker-srm/src/stac/search";
import { gridForBounds, blocksFor, utmEpsgForLonLat, type TargetGrid } from "../../disturbance-checker-srm/src/raster/grid";
import { CogCache, readObservationsBlock } from "../../disturbance-checker-srm/src/raster/cog";
import { buildComposite, RGB_EXTRA_BANDS, ATMOSPHERE_BANDS, RGB_OBSERVATION_COUNT } from "../../disturbance-checker-srm/src/raster/composite";
import { DEFAULT_MASK_OPTIONS } from "../../disturbance-checker-srm/src/raster/mask";
import { computeDeltas, emptyHistogram, accumulateHistogram, normalisationOffset, shiftBreaks, classifyDelta, CLASS_NODATA, OPTICAL_DELTA_IDS } from "../../disturbance-checker-srm/src/analysis/deltas";
import { buildWarp, paintRgb, paintClassified } from "../../disturbance-checker-srm/src/render/paint";

// toDataUrl needs a canvas; PNG encoding is browser work and is not timed here.
(globalThis as any).ImageData = class { constructor(public data: unknown, public width: number, public height: number) {} };
(globalThis as any).document = { createElement: () => ({ getContext: () => ({ putImageData() {} }), toDataURL: () => "data:," }) };

// Fetch wrapper: records every response, can replay them from memory, and holds
// each host to six connections at once, as Chrome does over HTTP/1.1.
type Saved = { status: number; headers: [string, string][]; body: ArrayBuffer };
const store = new Map<string, Saved>();
let mode: "record" | "replay" = "record";
const stats = { requests: 0, bytes: 0, misses: 0 };
const realFetch = globalThis.fetch;
const slots = new Map<string, { busy: number; queue: (() => void)[] }>();
async function acquire(host: string) {
  let s = slots.get(host);
  if (!s) slots.set(host, (s = { busy: 0, queue: [] }));
  if (s.busy < 6) { s.busy += 1; return; }
  await new Promise<void>((resolve) => s!.queue.push(resolve));
}
function release(host: string) {
  const s = slots.get(host)!;
  const next = s.queue.shift();
  if (next) next(); else s.busy -= 1;
}
function keyOf(input: any, init: any) {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const range = new Headers(init?.headers ?? undefined).get("range") ?? "";
  const body = typeof init?.body === "string" ? init.body : "";
  return { url, key: `${init?.method ?? "GET"} ${url} ${range} ${body}` };
}
globalThis.fetch = (async (input: any, init: any) => {
  const { url, key } = keyOf(input, init);
  if (mode === "replay") {
    const saved = store.get(key);
    if (!saved) { stats.misses += 1; throw new Error(`replay miss ${key.slice(0, 160)}`); }
    stats.requests += 1; stats.bytes += saved.body.byteLength;
    return new Response(saved.body.slice(0), { status: saved.status, headers: saved.headers });
  }
  const host = new URL(url).host;
  await acquire(host);
  try {
    const response = await realFetch(input, init);
    const body = await response.arrayBuffer();
    stats.requests += 1; stats.bytes += body.byteLength;
    const saved = { status: response.status, headers: [...response.headers] as [string, string][], body };
    store.set(key, saved);
    return new Response(body.slice(0), { status: saved.status, headers: saved.headers });
  } finally { release(host); }
}) as typeof fetch;

const ha = Number(process.argv[2] ?? 1600);
const side = Math.sqrt(ha) * 100; // metres
const lat = 44.0, lon = -122.5;
const dLat = side / 111_132 / 2, dLon = side / (111_320 * Math.cos((lat * Math.PI) / 180)) / 2;
const aoi = { kind: "rectangle" as const, west: lon - dLon, south: lat - dLat, east: lon + dLon, north: lat + dLat };
const period: Period = { id: "P1", preStart: "2024-08-01", preEnd: "2024-09-01", postStart: "2025-08-01", postEnd: "2025-09-01" };
const breaks = Object.fromEntries(Object.entries(DELTAS).map(([k, v]) => [k, v.defaults])) as RunParams["breaks"];
const params: RunParams = { aoi, periods: [period], normalise: true, maxCloud: 30, maskId: "scl", maskOptions: DEFAULT_MASK_OPTIONS, breaks };

const s = (ms: number) => (ms / 1000).toFixed(2);
const reset = () => { stats.requests = 0; stats.bytes = 0; stats.misses = 0; };

async function whole(label: string) {
  reset();
  const t0 = performance.now();
  const result = await runPeriod(period, params);
  const t = performance.now() - t0;
  const areas = OPTICAL_DELTA_IDS.map((id) => `${id} ${result.deltas[id]!.areasHa.map((a) => a.toFixed(2)).join("/")}`).join("; ");
  console.log(`${label}: ${s(t)} s, ${stats.requests} requests, ${(stats.bytes / 1e6).toFixed(1)} MB, area ${result.aoiAreaHa.toFixed(0)} ha, obs ${result.preObservations.length}+${result.postObservations.length}, blocks ${Math.ceil(result.grid.width / BLOCK_SIZE) * Math.ceil(result.grid.height / BLOCK_SIZE)}`);
  console.log(`  low/moderate/high ha: ${areas}`);
  return t;
}

// The same steps as runPeriod, in the same order, with a clock on each.
async function split() {
  reset();
  const t = { search: 0, read: 0, composite: 0, deltas: 0, classify: 0, paint: 0 };
  let c = performance.now();
  const bbox: [number, number, number, number] = [aoi.west, aoi.south, aoi.east, aoi.north];
  const [preAll, postAll] = await Promise.all([
    searchScenes({ bbox, start: period.preStart, end: period.preEnd, maxCloud: 30 }),
    searchScenes({ bbox, start: period.postStart, end: period.postEnd, maxCloud: 30 }),
  ]);
  const natural = utmEpsgForLonLat((bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2);
  const epsg = bestEpsgFor([...preAll, ...postAll], natural) ?? natural;
  const grid: TargetGrid = gridForBounds(epsg, aoi);
  const pre = observationsOnGrid(preAll, epsg).observations;
  const post = observationsOnGrid(postAll, epsg).observations;
  t.search += performance.now() - c;

  const { mask, assets } = assetsFor("scl");
  const cache = new CogCache();
  const total = grid.width * grid.height;
  const hist = Object.fromEntries(OPTICAL_DELTA_IDS.map((id) => [id, emptyHistogram(id)])) as Record<OpticalDeltaId, ReturnType<typeof emptyHistogram>>;
  const deltaGrid = Object.fromEntries(OPTICAL_DELTA_IDS.map((id) => [id, new Float32Array(total).fill(NaN)])) as Record<OpticalDeltaId, Float32Array>;
  const rgb = ["pr", "pg", "pb", "qr", "qg", "qb"].map(() => new Float32Array(total).fill(NaN));
  const subsetOf = (obs: Observation[]) => obs.map((o, index) => ({ index, cloud: o.cloudCover })).sort((a, b) => a.cloud - b.cloud).slice(0, RGB_OBSERVATION_COUNT).map((e) => e.index);
  const scatter = (dst: Float32Array, src: Float32Array, b: { x: number; y: number; width: number; height: number }) => {
    for (let row = 0; row < b.height; row += 1) dst.set(src.subarray(row * b.width, (row + 1) * b.width), (b.y + row) * grid.width + b.x);
  };

  for (const block of blocksFor(grid, BLOCK_SIZE)) {
    c = performance.now();
    const read = (obs: Observation[]) => {
      const wanted = new Set(subsetOf(obs));
      return readObservationsBlock(cache, obs, assets, block, { extraAssets: (i) => (wanted.has(i) ? [...RGB_EXTRA_BANDS, ...ATMOSPHERE_BANDS] : []) });
    };
    const [preBlocks, postBlocks] = await Promise.all([read(pre), read(post)]);
    t.read += performance.now() - c;

    c = performance.now();
    const shape = { width: block.width, height: block.height };
    const length = block.width * block.height;
    const preC = await buildComposite({ observations: pre, blocks: preBlocks, mask, maskOptions: DEFAULT_MASK_OPTIONS, length, shape, rgbSubset: subsetOf(pre) });
    const postC = await buildComposite({ observations: post, blocks: postBlocks, mask, maskOptions: DEFAULT_MASK_OPTIONS, length, shape, rgbSubset: subsetOf(post) });
    t.composite += performance.now() - c;

    c = performance.now();
    const d = computeDeltas(preC, postC);
    for (const id of OPTICAL_DELTA_IDS) { accumulateHistogram(hist[id], d[id]); scatter(deltaGrid[id], d[id], block); }
    t.deltas += performance.now() - c;

    c = performance.now();
    [preC.rgb.red, preC.rgb.green, preC.rgb.blue, postC.rgb.red, postC.rgb.green, postC.rgb.blue].forEach((a, i) => scatter(rgb[i], a, block));
    t.paint += performance.now() - c;
  }

  c = performance.now();
  const classes = OPTICAL_DELTA_IDS.map((id) => {
    const n = normalisationOffset(hist[id]);
    return classifyDelta(deltaGrid[id], n.applicable ? shiftBreaks(DELTAS[id].defaults, n.offset) : DELTAS[id].defaults);
  });
  t.classify += performance.now() - c;

  c = performance.now();
  const warp = buildWarp(grid);
  paintRgb(rgb[0], rgb[1], rgb[2], RGB_VIS, warp);
  paintRgb(rgb[3], rgb[4], rgb[5], RGB_VIS, warp);
  OPTICAL_DELTA_IDS.forEach((id, i) => paintClassified(classes[i], CLASS_PALETTES[id], warp));
  t.paint += performance.now() - c;
  void CLASS_NODATA;

  const sum = Object.values(t).reduce((a, b) => a + b, 0);
  console.log(`split (replayed): total ${s(sum)} s = search ${s(t.search)} + read and decode ${s(t.read)} + median ${s(t.composite)} + deltas and histogram ${s(t.deltas)} + classify ${s(t.classify)} + paint ${s(t.paint)}; misses ${stats.misses}`);
}

mode = "record";
const live = await whole(`live run, ${ha} ha`);
mode = "replay";
await whole("replay run 1");
const replay = await whole("replay run 2");
await split();
console.log(`network waiting, live minus replay: ${s(live - replay)} s of ${s(live)} s`);
