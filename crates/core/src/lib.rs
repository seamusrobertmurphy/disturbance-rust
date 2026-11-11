//! disturbance-core: the canopy disturbance check, ported from
//! disturbance-checker-srm 0.14.3. Each module matches one TypeScript file
//! there, so every number can be checked against the original.
//!
//! Rust note. `pub mod stac;` brings in the file `stac.rs`, much as
//! `source("stac.R")` or `import stac` would. `pub` makes it usable from
//! outside this crate; anything without `pub` stays private.

pub mod cog;
pub mod composite;
pub mod defaults;
pub mod deltas;
pub mod diagnostics;
pub mod grid;
pub mod mask;
pub mod patches;
pub mod radar;
pub mod rasterize;
pub mod render;
pub mod run;
pub mod stac;
