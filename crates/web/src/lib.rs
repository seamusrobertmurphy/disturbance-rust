//! The bridge between the web page and disturbance-core.
//!
//! WebAssembly is a compact program format that browsers run at close to
//! native speed. `wasm-pack` compiles this crate, and the core with it, into
//! `site/pkg/`, and the page's worker script calls the functions below.
//!
//! `run_check` runs one reporting period and keeps its analysis, the change
//! values of every pixel, under a key the page chooses. `reclassify` then
//! redraws that period's classes at new breaks in a fraction of a second,
//! with nothing downloaded again.
//!
//! Rust notes. `#[wasm_bindgen]` marks a function the page can call. The page
//! passes settings as JSON text and gets back JSON text plus the map images as
//! PNG bytes. `thread_local!` with `RefCell` is how a value is kept between
//! calls here, like a variable at the top of a Python module; the browser
//! runs this code on one thread, so nothing else can touch it at the same time.

use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap};

use disturbance_core::defaults::{Breaks, DeltaId};
use disturbance_core::run::{self, Analysis, Layer, RunParams};
use js_sys::{Array, Function, Object, Reflect, Uint8Array};
use wasm_bindgen::prelude::*;

thread_local! {
    static KEPT: RefCell<HashMap<String, Analysis>> = RefCell::new(HashMap::new());
}

fn js_error(message: impl AsRef<str>) -> JsValue {
    JsValue::from_str(message.as_ref())
}

/// `{json, png}`, where `png` holds each layer's image in order.
fn reply(json: String, layers: &[Layer]) -> Result<JsValue, JsValue> {
    let out = Object::new();
    Reflect::set(&out, &"json".into(), &JsValue::from_str(&json))?;
    let images = Array::new();
    for layer in layers {
        images.push(&Uint8Array::from(layer.png.as_slice()));
    }
    Reflect::set(&out, &"png".into(), &images)?;
    Ok(out.into())
}

/// Run the check for one period. `params` is a JSON object in the shape of
/// `RunParams`; `key` names the analysis kept for `reclassify`.
#[wasm_bindgen]
pub async fn run_check(params: String, progress: Function, key: String) -> Result<JsValue, JsValue> {
    console_error_panic_hook::set_once();
    let params: RunParams = serde_json::from_str(&params).map_err(|e| js_error(format!("Settings not understood: {e}")))?;
    let client = reqwest::Client::new();
    let report = |message: &str, fraction: f64| {
        let _ = progress.call2(&JsValue::NULL, &JsValue::from_str(message), &JsValue::from_f64(fraction));
    };
    let (result, analysis) = run::run(&client, &params, &report).await.map_err(js_error)?;
    KEPT.with(|kept| kept.borrow_mut().insert(key, analysis));
    let json = serde_json::to_string(&result).map_err(|e| js_error(e.to_string()))?;
    reply(json, &result.layers)
}

/// Redraw a kept period at new breaks. `breaks` is a JSON object of breaks
/// by change, `{"dNDVI": {"low": 0.1, "moderate": 0.2, "high": 0.35}, ...}`.
#[wasm_bindgen]
pub fn reclassify(key: String, breaks: String, normalise: bool) -> Result<JsValue, JsValue> {
    let breaks: BTreeMap<DeltaId, Breaks> = serde_json::from_str(&breaks).map_err(|e| js_error(format!("Breaks not understood: {e}")))?;
    KEPT.with(|kept| {
        let kept = kept.borrow();
        let analysis = kept.get(&key).ok_or_else(|| js_error("That run is no longer held. Run the check again."))?;
        let classified = run::classify(analysis, &breaks, normalise).map_err(js_error)?;
        let json = serde_json::to_string(&classified).map_err(|e| js_error(e.to_string()))?;
        reply(json, &classified.layers)
    })
}

/// Let go of every kept analysis, before a new run replaces them.
#[wasm_bindgen]
pub fn forget_all() {
    KEPT.with(|kept| kept.borrow_mut().clear());
}
