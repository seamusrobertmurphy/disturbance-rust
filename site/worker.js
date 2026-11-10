// Runs the Rust check in a background thread, so the page stays responsive.
import init, { run_check } from "./pkg/disturbance_web.js";

const ready = init();

self.onmessage = async (event) => {
  await ready;
  try {
    const result = await run_check(JSON.stringify(event.data), (message, fraction) => {
      self.postMessage({ type: "progress", message, fraction });
    });
    const png = Array.from(result.png);
    self.postMessage({ type: "done", json: result.json, png }, png.map((a) => a.buffer));
  } catch (error) {
    self.postMessage({ type: "error", message: String(error && error.message ? error.message : error) });
  }
};
