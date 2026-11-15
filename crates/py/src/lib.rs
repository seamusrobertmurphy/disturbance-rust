//! disturbance-core as a Python module, `disturbance._core`.
//!
//! The Python package in `python/disturbance` wraps this in the calls a
//! notebook makes. Everything crosses as JSON text or as raw bytes, which
//! the package turns into numpy arrays, so this side needs no numpy.
//!
//! A run holds its analysis, so `reclassify` can draw the classes again at
//! new breaks without downloading anything, as the web page does.
//!
//! Rust notes. `#[pyclass]` makes a Rust struct a Python class and
//! `#[pymethods]` its methods. `py.detach` lets go of Python's global lock
//! while the check downloads, and `Python::attach` takes it back to report
//! progress.

use std::collections::BTreeMap;

use disturbance_core::defaults::{Breaks, DeltaId};
use disturbance_core::run::{self as check, Analysis, RunParams, RunResult};
use pyo3::exceptions::{PyRuntimeError, PyValueError};
use pyo3::prelude::*;
use pyo3::types::PyBytes;

fn runtime_error(e: impl ToString) -> PyErr {
    PyRuntimeError::new_err(e.to_string())
}

/// One finished check.
#[pyclass(module = "disturbance._core")]
struct Run {
    result: RunResult,
    analysis: Analysis,
}

#[pymethods]
impl Run {
    /// The run record: settings, scenes, histograms, breaks, patches,
    /// warnings, checks and timings, as JSON text.
    fn record(&self) -> PyResult<String> {
        serde_json::to_string(&self.result).map_err(runtime_error)
    }

    /// The working grid: EPSG code, upper left corner in metres, pixel size,
    /// width and height.
    fn grid(&self) -> (u32, f64, f64, f64, u32, u32) {
        let g = &self.analysis.target;
        (g.epsg, g.origin_x, g.origin_y, g.resolution, g.width, g.height)
    }

    /// Each change as little-endian float32 bytes, row by row, NaN where
    /// there is none.
    fn deltas<'py>(&self, py: Python<'py>) -> Vec<(String, Bound<'py, PyBytes>)> {
        self.analysis
            .deltas
            .iter()
            .map(|(id, values)| {
                let bytes: Vec<u8> = values.iter().flat_map(|v| v.to_le_bytes()).collect();
                (id.name().to_string(), PyBytes::new(py, &bytes))
            })
            .collect()
    }

    /// Each change's classes at the breaks the run used: 0 unchanged, 1 low,
    /// 2 moderate, 3 high, 255 no data.
    fn classes<'py>(&self, py: Python<'py>) -> Vec<(String, Bound<'py, PyBytes>)> {
        self.analysis
            .deltas
            .iter()
            .filter_map(|(id, values)| {
                let used = self.result.deltas.iter().find(|d| d.id == *id)?.breaks_used;
                Some((id.name().to_string(), PyBytes::new(py, &disturbance_core::deltas::classify_delta(values, used))))
            })
            .collect()
    }

    /// The before and after pictures: key, name and each band as float32
    /// bytes. Reflectance for the optical check, VH in dB for radar.
    fn backdrops<'py>(&self, py: Python<'py>) -> Vec<(String, String, Vec<Bound<'py, PyBytes>>)> {
        self.result
            .backdrops
            .iter()
            .map(|b| {
                let bands = b.bands.iter().map(|band| PyBytes::new(py, &band.iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<u8>>())).collect();
                (b.key.clone(), b.name.clone(), bands)
            })
            .collect()
    }

    /// Every GeoTIFF of the run as file name and bytes.
    fn geotiffs<'py>(&self, py: Python<'py>) -> Vec<(String, Bound<'py, PyBytes>)> {
        disturbance_core::geotiff::run_files(&self.result, &self.analysis)
            .into_iter()
            .map(|(name, bytes)| (name, PyBytes::new(py, &bytes)))
            .collect()
    }

    /// Draw the classes again at new breaks, JSON text of breaks by change,
    /// `{"dNDVI": {"low": 0.1, "moderate": 0.2, "high": 0.35}}`. A change
    /// left out keeps its SOP defaults. Nothing is downloaded.
    fn reclassify(&mut self, breaks: &str, normalise: bool) -> PyResult<()> {
        let breaks: BTreeMap<DeltaId, Breaks> = serde_json::from_str(breaks).map_err(|e| PyValueError::new_err(format!("Breaks not understood: {e}")))?;
        let classified = check::classify(&self.analysis, &breaks, normalise).map_err(runtime_error)?;
        // The layers keep the true-colour pair and swap in the new classes.
        let mut layers: Vec<_> = self.result.layers.iter().filter(|l| !classified.layers.iter().any(|c| c.key == l.key)).cloned().collect();
        layers.extend(classified.layers);
        self.result.layers = layers;
        self.result.deltas = classified.deltas;
        self.result.patches = classified.patches;
        // Histogram checks are redrawn with the breaks; the date checks stay.
        let labels: Vec<String> = self.result.deltas.iter().map(|d| format!("{} {}", self.result.label, d.id.name())).collect();
        self.result.diagnostics.retain(|d| !labels.iter().any(|l| d.title.starts_with(l.as_str())));
        self.result.diagnostics.extend(classified.diagnostics);
        Ok(())
    }
}

/// Run one check. `params` is JSON text in the shape of `RunParams`;
/// `progress`, if given, is called with a message and a fraction.
#[pyfunction]
#[pyo3(signature = (params, progress=None))]
fn run(py: Python<'_>, params: &str, progress: Option<Py<PyAny>>) -> PyResult<Run> {
    let params: RunParams = serde_json::from_str(params).map_err(|e| PyValueError::new_err(format!("Settings not understood: {e}")))?;
    let outcome = py.detach(|| {
        let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().map_err(|e| e.to_string())?;
        let client = reqwest::Client::builder().build().map_err(|e| e.to_string())?;
        let report = |message: &str, fraction: f64| {
            if let Some(callback) = &progress {
                Python::attach(|py| {
                    let _ = callback.call1(py, (message, fraction));
                });
            }
        };
        runtime.block_on(check::run(&client, &params, &report))
    });
    let (result, analysis) = outcome.map_err(runtime_error)?;
    Ok(Run { result, analysis })
}

#[pymodule]
fn _core(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(run, m)?)?;
    m.add_class::<Run>()?;
    m.add("__version__", env!("CARGO_PKG_VERSION"))?;
    Ok(())
}
