// Runs one Sentinel-1 radar period of the checker and prints what the Rust port is compared on.
// Imports the checker's own modules unchanged from disturbance-checker-srm 0.14.3.
// Build and run from this folder, with the checker cloned beside this repository:
//   ../../disturbance-checker-srm/node_modules/.bin/esbuild checker-radar.ts --bundle --platform=node --format=esm --outfile=out/checker-radar.mjs
//   node out/checker-radar.mjs 1600 49.0 -81.0
import { runRadarPeriod } from "../../disturbance-checker-srm/src/analysis/radar";
import { DELTAS } from "../../disturbance-checker-srm/src/defaults";
import { DEFAULT_MASK_OPTIONS } from "../../disturbance-checker-srm/src/raster/mask";
import type { RunParams, Period } from "../../disturbance-checker-srm/src/analysis/run";

// toDataUrl needs a canvas; PNG encoding is browser work and is not timed here.
(globalThis as any).ImageData = class { constructor(public data: unknown, public width: number, public height: number) {} };
(globalThis as any).document = { createElement: () => ({ getContext: () => ({ putImageData() {} }), toDataURL: () => "data:," }) };

// Counts bytes and holds each host to six connections at once, as Chrome does.
const stats = { requests: 0, bytes: 0 };
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
globalThis.fetch = (async (input: any, init: any) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const host = new URL(url).host;
  await acquire(host);
  try {
    const response = await realFetch(input, init);
    const body = await response.arrayBuffer();
    stats.requests += 1; stats.bytes += body.byteLength;
    return new Response(body, { status: response.status, headers: [...response.headers] as [string, string][] });
  } finally { release(host); }
}) as typeof fetch;

const ha = Number(process.argv[2] ?? 1600);
const lat = Number(process.argv[3] ?? 49.0), lon = Number(process.argv[4] ?? -81.0);
const side = Math.sqrt(ha) * 100;
const dLat = side / 111_132 / 2, dLon = side / (111_320 * Math.cos((lat * Math.PI) / 180)) / 2;
const aoi = { kind: "rectangle" as const, west: lon - dLon, south: lat - dLat, east: lon + dLon, north: lat + dLat };
const period: Period = { id: "P1", preStart: "2023-12-05", preEnd: "2024-02-04", postStart: "2025-12-05", postEnd: "2026-02-04" };
const breaks = Object.fromEntries(Object.entries(DELTAS).map(([k, v]) => [k, v.defaults])) as RunParams["breaks"];
const params: RunParams = { aoi, periods: [period], normalise: true, maxCloud: 30, maskId: "scl", maskOptions: DEFAULT_MASK_OPTIONS, breaks };

const t0 = performance.now();
const result = await runRadarPeriod(period, params);
const seconds = ((performance.now() - t0) / 1000).toFixed(2);
const pixelHa = result.grid.resolution ** 2 / 10_000;
const pixels = (result.deltas.dVH!.areasHa as number[]).map((a) => Math.round(a / pixelHa));
console.log(`checker radar, ${ha} ha at ${lat}, ${lon}, ${period.preStart}/${period.preEnd} against ${period.postStart}/${period.postEnd}`);
console.log(`  EPSG:${result.grid.epsg} grid ${result.grid.width} x ${result.grid.height}, orbits ${result.radar!.orbits.join(",")} (${result.radar!.passes.join(",")}), scenes ${result.radar!.preScenes}+${result.radar!.postScenes}, dropped ${result.radar!.dropped}`);
console.log(`  shift ${result.radar!.shiftDb.toFixed(6)} dB, observed pixels ${result.observedPixels}`);
console.log(`  dVH class pixel counts for the port check [${pixels.join(", ")}]`);
console.log(`  ${seconds} s, ${stats.requests} requests, ${(stats.bytes / 1e6).toFixed(1)} MB`);
