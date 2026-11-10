//! The bridge between the web page and disturbance-core.
//!
//! WebAssembly is a compact program format that browsers run at close to
//! native speed. `wasm-pack` compiles this crate, and the core with it, into
//! `site/pkg/`, and the page's worker script calls `run_check` below.
//!
//! Rust note. `#[wasm_bindgen]` marks a function the page can call. The page
//! passes the settings as JSON text and a function for progress messages, and
//! gets back the result as JSON text plus the map images as PNG bytes.

use disturbance_core::run::{self, RunParams};
use js_sys::{Array, Function, Object, Reflect, Uint8Array};
use wasm_bindgen::prelude::*;

fn js_error(message: impl AsRef<str>) -> JsValue {
    JsValue::from_str(message.as_ref())
}

/// Run the check. `params` is a JSON object in the shape of `RunParams`.
#[wasm_bindgen]
pub async fn run_check(params: String, progress: Function) -> Result<JsValue, JsValue> {
    console_error_panic_hook::set_once();
    let params: RunParams = serde_json::from_str(&params).map_err(|e| js_error(format!("Settings not understood: {e}")))?;
    let client = reqwest::Client::new();
    let report = |message: &str, fraction: f64| {
        let _ = progress.call2(&JsValue::NULL, &JsValue::from_str(message), &JsValue::from_f64(fraction));
    };
    let result = run::run(&client, &params, &report).await.map_err(js_error)?;

    let out = Object::new();
    let json = serde_json::to_string(&result).map_err(|e| js_error(e.to_string()))?;
    Reflect::set(&out, &"json".into(), &JsValue::from_str(&json))?;
    let images = Array::new();
    for layer in &result.layers {
        images.push(&Uint8Array::from(layer.png.as_slice()));
    }
    Reflect::set(&out, &"png".into(), &images)?;
    Ok(out.into())
}
