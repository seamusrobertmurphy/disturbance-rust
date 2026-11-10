//! The working grid: the scenes' own UTM zone at 20 m, cut into 512 pixel
//! blocks. Ported from `src/raster/grid.ts` in disturbance-checker-srm 0.14.3.

use proj4rs::proj::Proj;

/// Pixel size in metres, the checker's `ANALYSIS_SCALE`. One pixel is 0.04 ha.
pub const GRID_RESOLUTION: f64 = 20.0;
/// Pixels per block side, the checker's `BLOCK_SIZE`.
pub const BLOCK_SIZE: u32 = 512;

#[derive(Clone, Copy, Debug)]
pub struct TargetGrid {
    pub epsg: u32,
    /// Upper left corner in metres.
    pub origin_x: f64,
    pub origin_y: f64,
    pub resolution: f64,
    pub width: u32,
    pub height: u32,
}

/// One block of the grid, with its bounds in metres as
/// west, south, east, north.
#[derive(Clone, Copy, Debug)]
pub struct GridBlock {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
    pub bbox: [f64; 4],
}

/// The same proj string the checker hands to proj4js.
fn utm_definition(epsg: u32) -> Result<String, String> {
    let zone = epsg % 100;
    let south = epsg / 100 == 327;
    if !(1..=60).contains(&zone) || !(epsg / 100 == 326 || south) {
        return Err(format!("EPSG:{epsg} is not a UTM zone code."));
    }
    Ok(format!(
        "+proj=utm +zone={zone}{} +datum=WGS84 +units=m +no_defs",
        if south { " +south" } else { "" }
    ))
}

/// Longitude and latitude in degrees to UTM metres.
pub fn lon_lat_to_utm(epsg: u32, lon: f64, lat: f64) -> Result<(f64, f64), String> {
    let from = Proj::from_proj_string("+proj=longlat +datum=WGS84 +no_defs").map_err(|e| e.to_string())?;
    let to = Proj::from_proj_string(&utm_definition(epsg)?).map_err(|e| e.to_string())?;
    // proj4rs works in radians, unlike proj4js.
    let mut point = (lon.to_radians(), lat.to_radians(), 0.0);
    proj4rs::transform::transform(&from, &to, &mut point).map_err(|e| e.to_string())?;
    Ok((point.0, point.1))
}

/// The UTM zone a point falls in.
pub fn utm_epsg_for_lon_lat(lon: f64, lat: f64) -> u32 {
    let zone = ((lon + 180.0) / 6.0).floor() as i64 + 1;
    let zone = zone.clamp(1, 60) as u32;
    (if lat >= 0.0 { 32600 } else { 32700 }) + zone
}

/// The smallest grid, snapped to whole pixels, that covers a box given in
/// degrees as west, south, east, north. The checker's `gridForBounds`.
pub fn grid_for_bounds(epsg: u32, bounds: [f64; 4], resolution: f64) -> Result<TargetGrid, String> {
    let [west, south, east, north] = bounds;
    let corners = [
        lon_lat_to_utm(epsg, west, south)?,
        lon_lat_to_utm(epsg, east, south)?,
        lon_lat_to_utm(epsg, west, north)?,
        lon_lat_to_utm(epsg, east, north)?,
    ];
    let min = |f: fn(&(f64, f64)) -> f64| corners.iter().map(f).fold(f64::INFINITY, f64::min);
    let max = |f: fn(&(f64, f64)) -> f64| corners.iter().map(f).fold(f64::NEG_INFINITY, f64::max);
    let min_x = (min(|c| c.0) / resolution).floor() * resolution;
    let max_x = (max(|c| c.0) / resolution).ceil() * resolution;
    let min_y = (min(|c| c.1) / resolution).floor() * resolution;
    let max_y = (max(|c| c.1) / resolution).ceil() * resolution;
    Ok(TargetGrid {
        epsg,
        origin_x: min_x,
        origin_y: max_y,
        resolution,
        width: (((max_x - min_x) / resolution).round() as u32).max(1),
        height: (((max_y - min_y) / resolution).round() as u32).max(1),
    })
}

/// The grid's blocks, row by row from the top left. The checker's `blocksFor`.
pub fn blocks_for(grid: &TargetGrid, block_size: u32) -> Vec<GridBlock> {
    let mut blocks = Vec::new();
    for y in (0..grid.height).step_by(block_size as usize) {
        for x in (0..grid.width).step_by(block_size as usize) {
            let width = block_size.min(grid.width - x);
            let height = block_size.min(grid.height - y);
            let min_x = grid.origin_x + x as f64 * grid.resolution;
            let max_y = grid.origin_y - y as f64 * grid.resolution;
            blocks.push(GridBlock {
                x,
                y,
                width,
                height,
                bbox: [
                    min_x,
                    max_y - height as f64 * grid.resolution,
                    min_x + width as f64 * grid.resolution,
                    max_y,
                ],
            });
        }
    }
    blocks
}
