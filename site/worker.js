// Runs the Rust check in a background thread, so the page stays responsive.
// The worker lives as long as the page's results, because it holds each
// period's change values for redrawing the classes at new breaks.
import init, { run_check, reclassify, forget_all } from "./pkg/disturbance_web.js";

const ready = init();

function images(result) {
  const png = Array.from(result.png);
  return { png, buffers: png.map((a) => a.buffer) };
}

self.onmessage = async (event) => {
  await ready;
  const m = event.data;
  try {
    if (m.type === "run") {
      const result = await run_check(JSON.stringify(m.params), (message, fraction) => {
        self.postMessage({ type: "progress", key: m.key, message, fraction });
      }, m.key);
      const { png, buffers } = images(result);
      self.postMessage({ type: "result", key: m.key, json: result.json, png }, buffers);
    } else if (m.type === "reclassify") {
      const result = reclassify(m.key, JSON.stringify(m.breaks), m.normalise);
      const { png, buffers } = images(result);
      self.postMessage({ type: "classified", id: m.id, key: m.key, json: result.json, png }, buffers);
    } else if (m.type === "forget") {
      forget_all();
    }
  } catch (error) {
    self.postMessage({ type: "error", key: m.key, id: m.id, message: String(error && error.message ? error.message : error) });
  }
};
