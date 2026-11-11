// Corroboration, ported from section 8 of the GeoLibre disturbance checker,
// disturbance-checker-srm version 0.14.3, src/reference and src/panel.
//
// The index maths says a delta moved. It cannot say why. The registries read
// here record what happened on the ground. They cover mapped fire, the aerial
// insect and disease survey, recorded management, LCMS change and the LANDFIRE
// disturbance agent.
//
// They corroborate and are never inputs. Nothing here changes a composite, a
// delta, a break or a class. No area of any record or of any spectral change
// is computed or shown, because no ground truthing has been done. Area fields
// are never asked for, and any a service sends anyway are dropped on arrival.
//
// Coverage is reported rather than left to be discovered. An empty answer from
// a survey that never flew reads like an empty answer from an undamaged forest,
// and the two mean opposite things.

/* global L */

// How long any one registry gets before it is given up on. The Forest Service
// activity layer answered a half-degree box in 35 seconds on 2026-09-07.
const TIMEOUT_MS = 90_000;

// How long to wait before asking a registry a second time.
const RETRY_PAUSE_MS = 1_500;

// Map panes for this module's layers, created once per map. Rasters sit above
// the run's own results and let clicks through, and vectors sit above them.
const RASTER_PANE = "dccRasterPane";
const VECTOR_PANE = "dccVectorPane";

// USDA Forest Service Insect and Disease Survey, damage points (layer 0) and areas (layer 1)
// https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_InsectandDiseaseSurvey_01/MapServer
const IDS_SERVICE =
  "https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_InsectandDiseaseSurvey_01/MapServer";
const IDS_POINTS_LAYER = 0;
const IDS_AREAS_LAYER = 1;

// MTBS burned area boundaries, one layer per year
// https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_MTBS_01/MapServer
const MTBS_SERVICE =
  "https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_MTBS_01/MapServer";

// WFIGS interagency fire perimeters, National Interagency Fire Center
// https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Interagency_Perimeters/FeatureServer/0
const NIFC_PERIMETERS =
  "https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Interagency_Perimeters/FeatureServer/0";

// National Burned Area Composite, Canadian Wildland Fire Information System web feature service
// https://cwfis.cfs.nrcan.gc.ca/geoserver/public/ows
const CWFIS_WFS = "https://cwfis.cfs.nrcan.gc.ca/geoserver/public/ows";

// Activity FACTS Common Attribute, Forest Service Activity Tracking System (layer 0)
// https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_ActivityFactsCommonAttributes_01/MapServer/0
const FACTS_SERVICE =
  "https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_ActivityFactsCommonAttributes_01/MapServer/0";

// Landscape Change Monitoring System image services, USDA Forest Service
// https://imagery.geoplatform.gov/iipp/rest/services/Vegetation
const LCMS_BASE = "https://imagery.geoplatform.gov/iipp/rest/services/Vegetation";

// LANDFIRE annual disturbance image services, one per year and region
// https://lfps.usgs.gov/arcgis/rest/services/Landfire_Disturbance
const LANDFIRE_FOLDER = "https://lfps.usgs.gov/arcgis/rest/services/Landfire_Disturbance";

const IDS_ATTRIBUTION =
  "USDA Forest Service, Forest Health Protection, Insect and Disease Survey";
const MTBS_ATTRIBUTION =
  "Monitoring Trends in Burn Severity, USGS and USDA Forest Service";
const NIFC_ATTRIBUTION =
  "Wildland Fire Interagency Geospatial Services, National Interagency Fire Center";
const NBAC_ATTRIBUTION =
  "National Burned Area Composite, Canadian Forest Service, Natural Resources Canada";
const FACTS_ATTRIBUTION =
  "Activity FACTS Common Attribute, Forest Service Activity Tracking System (FACTS), Natural Resource Manager, USDA Forest Service Enterprise Data Warehouse, service EDW_ActivityFactsCommonAttributes_01. It is published by the US Forest Service Enterprise Map Services Program";
const LCMS_ATTRIBUTION = "Landscape Change Monitoring System, USDA Forest Service";
const LANDFIRE_ATTRIBUTION =
  "LANDFIRE annual disturbance, USGS and USDA Forest Service";

// One colour per fire registry, so two outlines of the same fire can be told apart.
const FIRE_STYLE = {
  MTBS: { color: "#d7301f", name: "Fire, severity assessment (MTBS)", info: MTBS_ATTRIBUTION },
  NIFC: { color: "#fdae61", name: "Fire, operational perimeter (NIFC)", info: NIFC_ATTRIBUTION },
  NBAC: { color: "#7f0000", name: "Fire, burned area composite (NBAC)", info: NBAC_ATTRIBUTION },
};

const IDS_AREA_COLOUR = "#6a51a3";
const IDS_POINT_COLOUR = "#9e9ac8";

// The two "year of highest loss" products hold one raster for the whole record
// and are not time-enabled. Sending them a time made the service answer with an
// error inside a 200 response on 2026-11-10, so only the annual product gets one.
const LCMS_PRODUCTS = [
  {
    id: "change",
    label: "Annual change",
    description:
      "The change class assigned to each pixel for the year drawn, as the service's own legend names it.",
    service: `${LCMS_BASE}/USFS_EDW_LCMS_AnnualChange_CONUS/ImageServer`,
    timeEnabled: true,
  },
  {
    id: "fast-loss",
    label: "Year of highest fast loss",
    description:
      "The year each pixel was most likely to have undergone abrupt loss, the signature of harvest, fire and blowdown. One layer covers the whole record.",
    service: `${LCMS_BASE}/USFS_EDW_LCMS_YearHighestProbabilityFastLoss_CONUS/ImageServer`,
    timeEnabled: false,
  },
  {
    id: "slow-loss",
    label: "Year of highest slow loss",
    description:
      "The year each pixel was most likely to have undergone gradual loss, the signature of insect and disease mortality and drought. One layer covers the whole record.",
    service: `${LCMS_BASE}/USFS_EDW_LCMS_YearHighestProbabilitySlowLoss_CONUS/ImageServer`,
    timeEnabled: false,
  },
];

const LCMS_HINT =
  "The Landscape Change Monitoring System classifies change annually across the conterminous states from the full Landsat and Sentinel-2 record, by a method unlike this tool's. Agreement is corroboration; disagreement is the finding.";

const LANDFIRE_HINT =
  "LANDFIRE names the agent rather than the rate. Fire, clearcut, harvest, thinning, mastication, insects, disease, weather and development are separate classes. Where it and LCMS agree on a stand, two teams working from overlapping inputs reached the same answer. Where they disagree, that is what to chase.";

// Activity classes that remove or reduce canopy. Surveys, examinations,
// certifications and prescriptions are left out, because they would bury the
// few records that explain a delta under many that cannot.
const CANOPY_ACTIVITIES = [
  "Clearcut",
  "Seed Tree",
  "Shelterwood",
  "Overstory Removal",
  "Commercial Thin",
  "Precommercial Thin",
  "Salvage",
  "Sanitation",
  "Group Selection",
  "Single-tree Selection",
  "Patch Clearcut",
  "Improvement Cut",
  "Liberation Cut",
  "Thinning",
  "Mastication",
  "Broadcast Burning",
  "Piling",
  "Yarding",
];

// Rough extents in longitude and latitude, deliberately generous. A false
// positive costs one empty query, and a false negative would hide evidence.
const US_EXTENT = [
  [-125.1, 24.4, -66.9, 49.4], // Conterminous states
  [-179.2, 51.2, -129.9, 71.5], // Alaska
  [-160.3, 18.9, -154.8, 22.3], // Hawaii
  [-67.3, 17.9, -64.5, 18.6], // Puerto Rico and the Virgin Islands
];

// Canada as boxes that follow the border, so a western state does not test
// true for Canada and send a request to the Canadian server.
const CANADA_EXTENT = [
  [-141.1, 48.9, -95.15, 83.2], // West of the Lake of the Woods, the 49th parallel
  [-95.15, 48.0, -84.0, 83.2], // Northwestern Ontario
  [-84.0, 41.6, -74.3, 83.2], // Southern Ontario, which dips to Pelee Island
  [-74.3, 44.9, -66.9, 83.2], // Quebec, largely the 45th parallel
  [-69.1, 43.0, -52.6, 83.2], // The Maritimes and Newfoundland
];

// ------------------------------------------------------------ coverage

function overlapsAny(bbox, boxes) {
  const [west, south, east, north] = bbox;
  return boxes.some(([w, s, e, n]) => west < e && east > w && south < n && north > s);
}

function withinUnitedStates(bbox) {
  return overlapsAny(bbox, US_EXTENT);
}

function withinCanada(bbox) {
  return overlapsAny(bbox, CANADA_EXTENT);
}

// Only the conterminous LCMS services are wired up.
function withinConus(bbox) {
  const [west, south, east, north] = bbox;
  return west < -66.9 && east > -125.1 && south < 49.4 && north > 24.4;
}

// Alaska or the conterminous states, or null where no LANDFIRE product applies.
function landfireRegion(bbox) {
  if (overlapsAny(bbox, [[-125.1, 24.4, -66.9, 49.4]])) return "CONUS";
  if (overlapsAny(bbox, [[-179.2, 51.2, -129.9, 71.5]])) return "AK";
  return null;
}

// ------------------------------------------------------------ requests

function timeoutSignal(ms) {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(ms);
  }
  const controller = new AbortController();
  setTimeout(
    () => controller.abort(new DOMException(`No answer within ${ms / 1000} seconds.`, "TimeoutError")),
    ms,
  );
  return controller.signal;
}

// Ask twice before giving up. Three identical survey queries on 2026-09-08 took
// 447, 588 and 8,581 milliseconds, so one transient failure proves little. A
// timeout is not retried, because the clock stopped it on purpose.
async function attempt(run) {
  try {
    return await run(timeoutSignal(TIMEOUT_MS));
  } catch (error) {
    if (error && error.name === "TimeoutError") throw error;
    await new Promise((resolve) => setTimeout(resolve, RETRY_PAUSE_MS));
    return run(timeoutSignal(TIMEOUT_MS));
  }
}

function describeError(error) {
  if (error && error.name === "TimeoutError") {
    return `no answer within ${TIMEOUT_MS / 1000} seconds`;
  }
  if (error && error.name === "AbortError") return "The request was cancelled.";
  const message = error instanceof Error ? error.message : String(error ?? "Unknown error");
  // A blocked cross-origin request and a dead network look the same to fetch.
  if (/failed to fetch|networkerror|load failed/i.test(message)) {
    return "The service could not be reached. A blocked request and a lost network connection look the same to the browser.";
  }
  if (/\b5\d\d\b/.test(message)) {
    return `${message} This is a fault at the data provider rather than in the run parameters. Trying again shortly usually clears it.`;
  }
  return message;
}

// A plain GET for an ArcGIS REST endpoint. Each caller names the dataset and
// its link on the lines above the call.
async function getJson(url, params, signal) {
  const response = await fetch(`${url}?${new URLSearchParams(params)}`, { signal });
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status} ${response.statusText}`.trim() + ".");
  }
  const payload = await response.json();
  // ArcGIS reports failures inside a 200 response, so the status alone proves nothing.
  if (payload && typeof payload === "object" && payload.error) {
    throw new Error(payload.error.message ?? "The service rejected the query.");
  }
  return payload;
}

// The layers a map service lists, in its own order.
async function serviceLayers(serviceUrl, signal) {
  const payload = await getJson(serviceUrl, { f: "json" }, signal);
  return (payload.layers ?? []).map((layer) => ({ id: layer.id, name: layer.name }));
}

// Aggregate on the server, so a truncated page of features never passes for a total.
async function queryStats(layerUrl, { where, bbox, groupBy, statistics, signal }) {
  const payload = await getJson(
    `${layerUrl}/query`,
    {
      where: where ?? "1=1",
      geometry: bbox.join(","),
      geometryType: "esriGeometryEnvelope",
      inSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      outStatistics: JSON.stringify(statistics),
      groupByFieldsForStatistics: groupBy.join(","),
      f: "json",
    },
    signal,
  );
  return (payload.features ?? []).map((feature) => feature.attributes ?? {});
}

// Intersecting features as GeoJSON, generalised on the server where asked.
async function queryGeoJson(layerUrl, { where, bbox, outFields, simplify, limit, signal }) {
  const params = {
    where: where ?? "1=1",
    geometry: bbox.join(","),
    geometryType: "esriGeometryEnvelope",
    inSR: "4326",
    outSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields: (outFields ?? ["*"]).join(","),
    returnGeometry: "true",
    f: "geojson",
  };
  if (simplify) params.maxAllowableOffset = String(simplify);
  if (limit) params.resultRecordCount = String(limit);
  const payload = await getJson(`${layerUrl}/query`, params, signal);
  return { type: "FeatureCollection", features: payload.features ?? [] };
}

// A service's own legend, so classes are named as it names them. Each caller
// names the dataset and its link on the lines above the call. A missing legend
// is a cosmetic loss and never fails a run.
async function serviceLegend(serviceUrl, signal) {
  try {
    const response = await fetch(`${serviceUrl}/legend?f=json`, { signal });
    if (!response.ok) return [];
    const payload = await response.json();
    return (payload.layers?.[0]?.legend ?? [])
      .filter((entry) => entry.label && entry.imageData)
      .map((entry) => ({
        label: String(entry.label),
        swatch: `data:${entry.contentType ?? "image/png"};base64,${entry.imageData}`,
      }));
  } catch {
    return [];
  }
}

// ------------------------------------------------------------ dates

function epochToIso(value) {
  const millis = Number(value);
  if (!Number.isFinite(millis) || millis <= 0) return null;
  return new Date(millis).toISOString().slice(0, 10);
}

// MTBS gives 20200817 or an epoch in milliseconds, depending on the format.
function parseIgnition(value) {
  if (typeof value === "number" && value > 10_000_000_000) {
    return new Date(value).toISOString().slice(0, 10);
  }
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(String(value ?? ""));
  return compact ? `${compact[1]}-${compact[2]}-${compact[3]}` : null;
}

// The composite writes 2023-09-08Z.
function trimZ(value) {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(value ?? ""));
  return match ? match[1] : null;
}

const text = (value, fallback) => {
  if (value === null || value === undefined) return fallback;
  const s = String(value).trim();
  return s && s !== "Null" && s !== "NoData" ? s : fallback;
};

// A feature with its geometry and only the fields this module shows.
const cleanFeature = (feature, properties) => ({
  type: "Feature",
  geometry: feature?.geometry ?? null,
  properties,
});

// ------------------------------------------------------------ insect and disease survey

// Damage recorded over the area, by year, damage type and agent. Both survey
// layers are read, because an observer draws a large stand as a polygon and
// drops a point on a small one. The two hold different occurrences.
async function insectAndDisease(bbox, years, signal) {
  if (!withinUnitedStates(bbox)) return { covered: false, groups: [], missing: [] };
  if (years.length === 0) return { covered: true, groups: [], missing: [] };

  const where = `survey_year >= ${Math.min(...years)} AND survey_year <= ${Math.max(...years)}`;
  const groupBy = ["survey_year", "damage_type", "dca_common_name"];
  const count = { statisticType: "count", onStatisticField: "objectid", outStatisticFieldName: "records" };
  const trees = { statisticType: "sum", onStatisticField: "tree_count", outStatisticFieldName: "total_trees" };

  // One layer being down must not read as no damage, so the two settle apart.
  const [areaSettled, pointSettled] = await Promise.allSettled([
    // USDA Forest Service Insect and Disease Survey, damage areas (layer 1)
    // https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_InsectandDiseaseSurvey_01/MapServer
    queryStats(`${IDS_SERVICE}/${IDS_AREAS_LAYER}`, { where, bbox, groupBy, statistics: [count], signal }),
    // USDA Forest Service Insect and Disease Survey, damage points (layer 0)
    // https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_InsectandDiseaseSurvey_01/MapServer
    queryStats(`${IDS_SERVICE}/${IDS_POINTS_LAYER}`, { where, bbox, groupBy, statistics: [count, trees], signal }),
  ]);

  if (areaSettled.status === "rejected" && pointSettled.status === "rejected") {
    throw areaSettled.reason;
  }

  const read = (settled, mapping) =>
    (settled.status === "fulfilled" ? settled.value : []).map((row) => ({
      year: Number(row.survey_year ?? 0),
      damageType: String(row.damage_type ?? "unrecorded"),
      agent: String(row.dca_common_name ?? "unknown"),
      records: Number(row.records ?? 0),
      trees: Number(row.total_trees ?? 0),
      mapping,
    }));

  const missing = [
    ...(areaSettled.status === "rejected" ? ["area"] : []),
    ...(pointSettled.status === "rejected" ? ["point"] : []),
  ];

  const groups = [...read(areaSettled, "area"), ...read(pointSettled, "point")]
    .filter((group) => group.records > 0)
    .sort((a, b) => b.year - a.year || b.records - a.records);

  return { covered: true, groups, missing };
}

// The survey's own shapes, so each record can be read against the stand the
// delta moved on. Areas and points come back apart because they draw apart.
async function damageGeometry(bbox, years, signal) {
  const empty = { type: "FeatureCollection", features: [] };
  if (!withinUnitedStates(bbox) || years.length === 0) {
    return { areas: empty, points: empty, failed: [] };
  }
  const where = `survey_year >= ${Math.min(...years)} AND survey_year <= ${Math.max(...years)}`;
  const outFields = ["survey_year", "damage_type", "dca_common_name"];

  const [areas, points] = await Promise.allSettled([
    // USDA Forest Service Insect and Disease Survey, damage areas (layer 1)
    // https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_InsectandDiseaseSurvey_01/MapServer
    queryGeoJson(`${IDS_SERVICE}/${IDS_AREAS_LAYER}`, {
      where,
      bbox,
      outFields,
      // Sketch-mapped polygons are drawn for position rather than measured.
      simplify: 0.0002,
      limit: 400,
      signal,
    }),
    // USDA Forest Service Insect and Disease Survey, damage points (layer 0)
    // https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_InsectandDiseaseSurvey_01/MapServer
    queryGeoJson(`${IDS_SERVICE}/${IDS_POINTS_LAYER}`, {
      where,
      bbox,
      outFields: [...outFields, "tree_count"],
      limit: 400,
      signal,
    }),
  ]);

  const clean = (settled, withTrees) => ({
    type: "FeatureCollection",
    features: (settled.status === "fulfilled" ? settled.value.features : []).map((feature) => {
      const p = feature?.properties ?? {};
      const properties = {
        year: Number(p.survey_year ?? 0),
        damageType: text(p.damage_type, "unrecorded"),
        agent: text(p.dca_common_name, "unknown"),
      };
      if (withTrees) properties.trees = p.tree_count == null ? null : Number(p.tree_count);
      return cleanFeature(feature, properties);
    }),
  });

  const failed = [
    ...(areas.status === "rejected" ? [describeError(areas.reason)] : []),
    ...(points.status === "rejected" ? [describeError(points.reason)] : []),
  ];
  return { areas: clean(areas, false), points: clean(points, true), failed };
}

// ------------------------------------------------------------ fire

const YEAR_LAYER = /^(\d{4})\s+Burned Area Boundaries$/;

// Fires MTBS mapped into the area. Severity is assessed a year or more after
// the fire, so a missing year is reported as unassessed, never as unburned.
async function burnedAreas(bbox, years, signal) {
  // MTBS burned area boundaries, the service's own list of yearly layers
  // https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_MTBS_01/MapServer
  const layers = await serviceLayers(MTBS_SERVICE, signal);
  const byYear = new Map();
  for (const layer of layers) {
    const match = YEAR_LAYER.exec(String(layer.name).trim());
    if (match) byYear.set(Number(match[1]), layer);
  }

  const records = [];
  const features = [];
  const unavailable = [];
  for (const year of years) {
    const layer = byYear.get(year);
    if (!layer) {
      unavailable.push(year);
      continue;
    }
    // MTBS burned area boundaries for one year
    // https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_MTBS_01/MapServer
    const collection = await queryGeoJson(`${MTBS_SERVICE}/${layer.id}`, {
      bbox,
      outFields: ["fire_name", "year", "ig_date"],
      // Perimeters are drawn for orientation, not measured.
      simplify: 0.0002,
      signal,
    });
    for (const feature of collection.features) {
      const p = feature?.properties ?? {};
      const record = {
        source: "MTBS",
        name: text(p.fire_name, "unnamed"),
        year: Number(p.year ?? year),
        started: parseIgnition(p.ig_date),
        ended: null,
        cause: null,
      };
      records.push(record);
      features.push(cleanFeature(feature, { ...record }));
    }
  }
  return { records, features, yearsUnavailable: unavailable };
}

// Interagency perimeters, same season, filtered by year here because the date
// fields are epochs and a server-side range on them is fragile.
async function interagencyFires(bbox, years, signal) {
  // WFIGS interagency fire perimeters, National Interagency Fire Center
  // https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Interagency_Perimeters/FeatureServer/0
  const collection = await queryGeoJson(NIFC_PERIMETERS, {
    bbox,
    outFields: [
      "poly_IncidentName",
      "attr_FireDiscoveryDateTime",
      "attr_ContainmentDateTime",
      "attr_FireCause",
    ],
    simplify: 0.0002,
    limit: 200,
    signal,
  });

  const wanted = new Set(years);
  const records = [];
  const features = [];
  for (const feature of collection.features) {
    const p = feature?.properties ?? {};
    const started = epochToIso(p.attr_FireDiscoveryDateTime);
    const year = started ? Number(started.slice(0, 4)) : Number.NaN;
    if (!Number.isFinite(year) || !wanted.has(year)) continue;
    const record = {
      source: "NIFC",
      name: text(p.poly_IncidentName, "unnamed"),
      year,
      started,
      ended: epochToIso(p.attr_ContainmentDateTime),
      cause: text(p.attr_FireCause, null),
    };
    records.push(record);
    if (feature?.geometry) features.push(cleanFeature(feature, { ...record }));
  }
  return { records, features };
}

// Canadian burned area. WFS 2.0 with the URN form of EPSG:4326 takes latitude
// first, and a longitude-first box returns an empty 200 that looks unburned.
async function canadianFires(bbox, years, signal) {
  const [west, south, east, north] = bbox;
  const params = new URLSearchParams({
    service: "WFS",
    version: "2.0.0",
    request: "GetFeature",
    typeNames: "public:nbac",
    bbox: `${south},${west},${north},${east},urn:ogc:def:crs:EPSG::4326`,
    outputFormat: "application/json",
    count: "200",
  });

  // National Burned Area Composite, Canadian Forest Service
  // https://cwfis.cfs.nrcan.gc.ca/geoserver/public/ows
  const response = await fetch(`${CWFIS_WFS}?${params}`, { signal });
  if (!response.ok) {
    throw new Error(`The Canadian burned area service returned ${response.status}.`);
  }
  const payload = await response.json();

  const wanted = new Set(years);
  const records = [];
  const features = [];
  for (const feature of payload.features ?? []) {
    const p = feature?.properties ?? {};
    const year = Number(p.year ?? 0);
    if (!wanted.has(year)) continue;
    // The composite numbers its fires and names none, so no name is invented.
    // Its area fields, adj_ha, poly_ha and shape_area, are dropped here.
    const record = {
      source: "NBAC",
      name: `NBAC fire ${p.nfireid ?? "unnumbered"}`,
      year,
      started: trimZ(p.ag_sdate ?? p.hs_sdate),
      ended: trimZ(p.ag_edate ?? p.hs_edate),
      cause: text(p.firecaus, null),
    };
    records.push(record);
    features.push(cleanFeature(feature, { ...record }));
  }
  return { records, features };
}

// Every fire registry that covers the area. Each runs on its own and fails on
// its own, so one registry being down never loses the other two.
async function fireEvidence(bbox, years, signal) {
  const unitedStates = withinUnitedStates(bbox);
  const canada = withinCanada(bbox);
  const records = [];
  const features = [];
  const sources = [];
  let yearsUnassessed = [];
  const jobs = [];

  if (unitedStates) {
    jobs.push(
      burnedAreas(bbox, years, signal)
        .then((found) => {
          records.push(...found.records);
          features.push(...found.features);
          yearsUnassessed = found.yearsUnavailable;
          sources.push("MTBS");
        })
        .catch(() => {}),
    );
    jobs.push(
      interagencyFires(bbox, years, signal)
        .then((found) => {
          records.push(...found.records);
          features.push(...found.features);
          sources.push("NIFC");
        })
        .catch(() => {}),
    );
  }
  if (canada) {
    jobs.push(
      canadianFires(bbox, years, signal)
        .then((found) => {
          records.push(...found.records);
          features.push(...found.features);
          sources.push("NBAC");
        })
        .catch(() => {}),
    );
  }
  await Promise.all(jobs);

  // Newest first, then by registry and name. Never by size.
  const order = { MTBS: 0, NIFC: 1, NBAC: 2 };
  records.sort(
    (a, b) =>
      b.year - a.year ||
      (order[a.source] ?? 9) - (order[b.source] ?? 9) ||
      a.name.localeCompare(b.name),
  );
  sources.sort((a, b) => (order[a] ?? 9) - (order[b] ?? 9));
  return { records, features, yearsUnassessed, sources };
}

// ------------------------------------------------------------ management record

function activityFilter() {
  return CANOPY_ACTIVITIES.map((term) => `activity LIKE '%${term.replace(/'/g, "''")}%'`).join(" OR ");
}

// Canopy-affecting activities recorded over the area within the years asked.
// Filtered by completion year here, because records with no completion date
// are counted and reported, and a server-side date range would drop them.
async function managementActivity(bbox, years, signal) {
  if (years.length === 0) return { queried: false, activities: [], undated: 0 };

  // Activity FACTS Common Attribute, Forest Service Activity Tracking System (layer 0)
  // https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_ActivityFactsCommonAttributes_01/MapServer/0
  const collection = await queryGeoJson(FACTS_SERVICE, {
    where: activityFilter(),
    bbox,
    outFields: ["activity", "date_completed", "method"],
    simplify: 0.0002,
    limit: 400,
    signal,
  });

  const wanted = new Set(years);
  const activities = [];
  let undated = 0;
  for (const feature of collection.features) {
    const p = feature?.properties ?? {};
    const completed = epochToIso(p.date_completed);
    if (!completed) {
      undated += 1;
      continue;
    }
    if (!wanted.has(Number(completed.slice(0, 4)))) continue;
    activities.push({
      activity: text(p.activity, "unrecorded"),
      completed,
      method: text(p.method, null),
    });
  }
  activities.sort((a, b) => (b.completed ?? "").localeCompare(a.completed ?? ""));
  return { queried: true, activities, undated };
}

// National Forest System land only, so this is asked only inside the United
// States. A failure reads as no record at all, as in the checker.
async function managementRecord(bbox, years, signal) {
  if (!withinUnitedStates(bbox)) return null;
  try {
    return await managementActivity(bbox, years, signal);
  } catch {
    return null;
  }
}

// ------------------------------------------------------------ LANDFIRE and LCMS

// LF2023_Dist23_CONUS is release 2023, disturbance year 2023, conterminous.
// The LDist and PDist variants are fuel derivatives and are not offered.
const LANDFIRE_NAME = /^LF(\d{4})_Dist(\d{2})_(CONUS|AK)$/;

let landfireCatalogue = null;

function loadLandfireCatalogue(signal) {
  if (!landfireCatalogue) {
    // LANDFIRE annual disturbance, the folder listing every yearly service
    // https://lfps.usgs.gov/arcgis/rest/services/Landfire_Disturbance
    landfireCatalogue = fetch(`${LANDFIRE_FOLDER}?f=json`, { signal })
      .then((response) => {
        if (!response.ok) {
          throw new Error(
            `The LANDFIRE catalogue returned ${response.status}. The overlay is unavailable; the analysis is unaffected.`,
          );
        }
        return response.json();
      })
      .then((payload) => {
        const services = [];
        for (const entry of payload.services ?? []) {
          const name = String(entry.name ?? "").split("/").pop() ?? "";
          const match = LANDFIRE_NAME.exec(name);
          if (!match) continue;
          const suffix = Number(match[2]);
          services.push({
            release: Number(match[1]),
            // Two-digit years run from 1999. Anything below 50 is this century.
            year: suffix < 50 ? 2000 + suffix : 1900 + suffix,
            region: match[3],
            name,
            url: `${LANDFIRE_FOLDER}/${name}/ImageServer`,
          });
        }
        return services;
      })
      .catch((error) => {
        landfireCatalogue = null;
        throw error;
      });
  }
  return landfireCatalogue;
}

// The newest release wins where a year appears more than once, because
// LANDFIRE revises earlier years and stands behind its current release.
function landfireServiceFor(services, year, region) {
  const matches = services
    .filter((service) => service.year === year && service.region === region)
    .sort((a, b) => b.release - a.release);
  return matches[0] ?? null;
}

// The post window's year where LANDFIRE has published it, or else the newest
// year it has. LANDFIRE lags the calendar, and the layer is named for the year
// actually drawn.
async function landfireChoice(bbox, year, signal) {
  const region = landfireRegion(bbox);
  if (!region) return null;
  const catalogue = await loadLandfireCatalogue(signal);
  let service = landfireServiceFor(catalogue, year, region);
  if (!service) {
    const newest = catalogue
      .filter((entry) => entry.region === region)
      .map((entry) => entry.year)
      .sort((a, b) => b - a)[0];
    service = newest ? landfireServiceFor(catalogue, newest, region) : null;
  }
  if (!service) return { region, asked: year, service: null, legend: [] };
  // LANDFIRE annual disturbance, the chosen year's own legend
  // https://lfps.usgs.gov/arcgis/rest/services/Landfire_Disturbance
  const legend = await serviceLegend(service.url, signal);
  return { region, asked: year, service, legend };
}

async function lcmsLegends(bbox, signal) {
  if (!withinConus(bbox)) return null;
  return Promise.all(
    LCMS_PRODUCTS.map((product) =>
      // Landscape Change Monitoring System, each product's own legend
      // https://imagery.geoplatform.gov/iipp/rest/services/Vegetation
      serviceLegend(product.service, signal),
    ),
  );
}

// ------------------------------------------------------------ drawing

const WEB_MERCATOR_HALF = 20037508.342789244;

// A Leaflet tile layer that asks an ArcGIS export or exportImage endpoint for
// each 256 pixel web map tile by its bounding box. Tiles load only over the
// area of interest, as the checker drew these overlays only over its grid.
function exportTileLayer({ url, endpoint, params, bounds, opacity, attribution, pane }) {
  const layer = L.tileLayer("", {
    tileSize: 256,
    opacity,
    attribution,
    bounds,
    ...(pane ? { pane } : {}),
  });
  layer.getTileUrl = (coords) => {
    const span = (2 * WEB_MERCATOR_HALF) / 2 ** coords.z;
    const minX = -WEB_MERCATOR_HALF + coords.x * span;
    const maxY = WEB_MERCATOR_HALF - coords.y * span;
    const query = new URLSearchParams({
      bbox: [minX, maxY - span, minX + span, maxY].join(","),
      bboxSR: "3857",
      imageSR: "3857",
      size: "256,256",
      format: "png32",
      transparent: "true",
      f: "image",
      ...params,
    });
    return `${url}/${endpoint}?${query}`;
  };
  return layer;
}

function ensurePanes(map) {
  if (!map || typeof map.createPane !== "function") return { raster: null, vector: null };
  if (!map.getPane(RASTER_PANE)) {
    const pane = map.createPane(RASTER_PANE);
    pane.style.zIndex = "420";
    pane.style.pointerEvents = "none";
  }
  if (!map.getPane(VECTOR_PANE)) {
    const pane = map.createPane(VECTOR_PANE);
    pane.style.zIndex = "430";
  }
  return { raster: RASTER_PANE, vector: VECTOR_PANE };
}

const STYLE_ID = "dcc-corroborate-style";

function injectStyle() {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
.dcc-legend { display: flex; flex-direction: column; gap: 3px; font-size: 12px; color: var(--muted); }
.dcc-legend-scroll { max-height: 180px; overflow-y: auto; padding-right: 4px; }
.dcc-legend-item { display: flex; align-items: center; gap: 6px; }
.dcc-swatch { display: inline-block; flex: none; width: 16px; height: 11px; border: 1.5px solid; border-radius: 2px; }
.dcc-swatch-dashed { border-style: dashed; }
.dcc-swatch-dot { width: 9px; height: 9px; border-radius: 50%; border: 1px solid var(--panel); }
.dcc-legend-img { flex: none; width: 16px; height: 16px; }
.dcc-legend-empty { color: var(--muted); font-size: 12px; }
.dcc-popup-wrap .leaflet-popup-content-wrapper,
.dcc-popup-wrap .leaflet-popup-tip { background: var(--panel); color: var(--ink); border: 1px solid var(--line); }
.dcc-popup-wrap .leaflet-popup-close-button { color: var(--muted); }
.dcc-popup { font-size: 13px; line-height: 1.4; }
.dcc-popup-title { font-weight: 600; margin-bottom: 4px; }
.dcc-popup-row { display: flex; gap: 8px; }
.dcc-popup-key { color: var(--muted); min-width: 70px; }
.dcc-popup-source { margin-top: 6px; padding-top: 4px; border-top: 1px solid var(--line); color: var(--muted); font-size: 11px; }
`;
  document.head.appendChild(style);
}

const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

function popupHtml(title, rows, source) {
  const body = rows
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(
      ([key, value]) =>
        `<div class="dcc-popup-row"><span class="dcc-popup-key">${escapeHtml(key)}</span><span>${escapeHtml(value)}</span></div>`,
    )
    .join("");
  return `<div class="dcc-popup"><div class="dcc-popup-title">${escapeHtml(title)}</div>${body}<div class="dcc-popup-source">${escapeHtml(source)}</div></div>`;
}

const POPUP_OPTIONS = { className: "dcc-popup-wrap", maxWidth: 300 };

function vectorLegend(label, colour, kind) {
  const swatch =
    kind === "point"
      ? `<span class="dcc-swatch dcc-swatch-dot" style="background:${colour}"></span>`
      : `<span class="dcc-swatch${kind === "dashed" ? " dcc-swatch-dashed" : ""}" style="border-color:${colour};background:${colour}47"></span>`;
  return `<div class="dcc-legend"><div class="dcc-legend-item">${swatch}<span>${escapeHtml(label)}</span></div></div>`;
}

function rasterLegend(entries) {
  if (!entries || entries.length === 0) {
    return `<div class="dcc-legend-empty">The service published no legend.</div>`;
  }
  const items = entries
    .map(
      (entry) =>
        `<div class="dcc-legend-item"><img class="dcc-legend-img" alt="" src="${escapeHtml(entry.swatch)}"><span>${escapeHtml(entry.label)}</span></div>`,
    )
    .join("");
  return `<div class="dcc-legend dcc-legend-scroll">${items}</div>`;
}

const FIRE_DATE_LABELS = {
  MTBS: ["Ignition", null],
  NIFC: ["Discovered", "Contained"],
  NBAC: ["Started", "Ended"],
};

function fireLayer(source, features, pane) {
  const style = FIRE_STYLE[source];
  const [startLabel, endLabel] = FIRE_DATE_LABELS[source];
  return L.geoJSON(
    { type: "FeatureCollection", features },
    {
      ...(pane ? { pane } : {}),
      style: {
        color: style.color,
        weight: 1.5,
        dashArray: "6 3",
        fillColor: style.color,
        fillOpacity: 0.22,
      },
      onEachFeature: (feature, layer) => {
        const p = feature.properties ?? {};
        layer.bindPopup(
          popupHtml(
            `${p.name}, ${p.year}`,
            [
              ["Registry", style.name],
              [startLabel, p.started],
              ...(endLabel ? [[endLabel, p.ended]] : []),
              ["Cause", p.cause],
            ],
            style.info,
          ),
          POPUP_OPTIONS,
        );
      },
    },
  );
}

function damageAreaLayer(collection, pane) {
  return L.geoJSON(collection, {
    ...(pane ? { pane } : {}),
    style: {
      color: IDS_AREA_COLOUR,
      weight: 1.5,
      opacity: 0.9,
      fillColor: IDS_AREA_COLOUR,
      fillOpacity: 0.28,
    },
    onEachFeature: (feature, layer) => {
      const p = feature.properties ?? {};
      layer.bindPopup(
        popupHtml(
          `${p.agent}, ${p.year}`,
          [
            ["Damage", p.damageType],
            ["Mapped as", "Sketched polygon"],
          ],
          `${IDS_ATTRIBUTION}, damage areas`,
        ),
        POPUP_OPTIONS,
      );
    },
  });
}

function damagePointLayer(collection, pane) {
  return L.geoJSON(collection, {
    ...(pane ? { pane } : {}),
    pointToLayer: (feature, latlng) =>
      L.circleMarker(latlng, {
        ...(pane ? { pane } : {}),
        radius: 4.5,
        color: "#ffffff",
        weight: 1,
        opacity: 0.85,
        fillColor: IDS_POINT_COLOUR,
        fillOpacity: 0.8,
      }),
    onEachFeature: (feature, layer) => {
      const p = feature.properties ?? {};
      layer.bindPopup(
        popupHtml(
          `${p.agent}, ${p.year}`,
          [
            ["Damage", p.damageType],
            ["Trees", p.trees > 0 ? p.trees.toLocaleString() : null],
            ["Mapped as", "Observation point"],
          ],
          `${IDS_ATTRIBUTION}, damage points`,
        ),
        POPUP_OPTIONS,
      );
    },
  });
}

// ------------------------------------------------------------ the run record

function recordRow(label, value) {
  const head = label.length >= 14 ? `${label} ` : label.padEnd(14);
  return `  ${head}${value}`;
}

const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

function groupMeasure(group) {
  if (group.mapping === "area") return plural(group.records, "sketched polygon", "sketched polygons");
  const points = plural(group.records, "observation point", "observation points");
  return group.trees > 0 ? `${points}, ${plural(group.trees, "tree", "trees")}` : points;
}

// The checker's manifest block, with every acreage taken out. The survey line
// also separates a failed read and an unsurveyed area from a clean one.
function buildRecord({ years, fires, ids, idsFailed, management }) {
  const lines = ["--- Corroborating record ---"];
  lines.push(recordRow("Queried", `${years[0]} to ${years[years.length - 1]}, over the area of interest`));
  lines.push(recordRow("Fire registries", fires.sources.join(", ") || "none answered"));
  if (fires.records.length === 0) {
    lines.push(recordRow("Fire", "no mapped fire intersects this area in these years"));
  } else {
    for (const fire of fires.records) {
      const window = [fire.started, fire.ended].filter(Boolean).join(" to ");
      lines.push(recordRow("Fire", `[${fire.source}] ${fire.name} (${fire.year})${window ? `, ${window}` : ""}`));
    }
    lines.push(
      recordRow(
        "Note",
        "one fire may appear under more than one registry. An operational perimeter and a severity assessment measure different things and must not be averaged.",
      ),
    );
  }
  if (fires.yearsUnassessed.length > 0) {
    lines.push(
      recordRow(
        "NOT ASSESSED",
        `burn severity is not yet published for ${fires.yearsUnassessed.join(", ")}; absence is not evidence`,
      ),
    );
  }
  if (idsFailed) {
    lines.push(recordRow("Forest health", `the survey was not read (${idsFailed}); nothing is known either way, so this is not an absence`));
  } else if (!ids.covered) {
    lines.push(recordRow("Forest health", "outside the surveyed area, so nothing was asked; an absence of jurisdiction, not of damage"));
  } else if (ids.groups.length === 0) {
    lines.push(recordRow("Forest health", "no damage recorded over this area in these years"));
  } else {
    lines.push(recordRow("Forest health", `${plural(ids.groups.length, "agent-year group", "agent-year groups")} recorded`));
    for (const group of ids.groups.slice(0, 10)) {
      lines.push(`    ${group.year}  ${group.damageType}, ${group.agent}, ${groupMeasure(group)}`);
    }
  }
  if (management) {
    if (management.activities.length === 0) {
      lines.push(
        recordRow(
          "Management",
          "no canopy-affecting activity recorded; National Forest System land only, so absence may be jurisdictional",
        ),
      );
    } else {
      lines.push(
        recordRow(
          "Management",
          `${plural(management.activities.length, "record", "records")} of canopy-affecting activity`,
        ),
      );
      for (const activity of management.activities.slice(0, 10)) {
        lines.push(`    ${activity.completed}  ${activity.activity}`);
      }
    }
    if (management.undated > 0) {
      lines.push(
        recordRow(
          "UNDATED",
          `${plural(management.undated, "activity record carries", "activity records carry")} no completion date and could not be placed in a year`,
        ),
      );
    }
  }
  lines.push(
    recordRow(
      "Sources",
      "MTBS (USGS and USFS); WFIGS (NIFC); NBAC (Canadian Forest Service); USFS Forest Health Protection IDS; USFS FACTS; LANDFIRE",
    ),
  );
  lines.push(
    recordRow(
      "Note",
      "corroborating evidence only. No composite, delta, break or area in this report is derived from it.",
    ),
  );
  return lines;
}

// ------------------------------------------------------------ the export

function normaliseBounds(bounds) {
  if (!Array.isArray(bounds) || bounds.length !== 4) return null;
  const values = bounds.map(Number);
  if (!values.every(Number.isFinite)) return null;
  const [w, s, e, n] = values;
  return [Math.min(w, e), Math.min(s, n), Math.max(w, e), Math.max(s, n)];
}

// Every calendar year from the start of the pre window to the end of the post
// window. A fire between the two windows explains the delta as well as one in them.
function yearsBetween(years) {
  const from = Math.trunc(Number(years?.from));
  const to = Math.trunc(Number(years?.to));
  if (!Number.isFinite(from) || !Number.isFinite(to)) return [];
  const list = [];
  for (let year = Math.min(from, to); year <= Math.max(from, to); year += 1) list.push(year);
  return list;
}

/**
 * Gather the corroborating record over an area for a span of years.
 *
 * bounds is [west, south, east, north] in degrees. years is { from, to } as
 * integers. onProgress(message) is optional. The layers come back built but
 * not added to the map.
 */
export async function loadCorroboration(map, bounds, years, onProgress) {
  if (typeof L === "undefined") {
    throw new Error("Leaflet must load before the corroboration module runs.");
  }
  injectStyle();
  const say = (message) => {
    try {
      onProgress?.(message);
    } catch {
      // A progress callback that throws must not stop the search.
    }
  };

  const layers = [];
  const notes = [];
  const records = { fires: [], insects: [], management: [] };
  const result = { layers, records, record: [], notes };

  const bbox = normaliseBounds(bounds);
  if (!bbox) {
    notes.push("Set an area of interest first.");
    return result;
  }
  const yearList = yearsBetween(years);
  if (yearList.length === 0) {
    notes.push("Set the reporting windows first, so there are years to search.");
    return result;
  }
  const lastYear = yearList[yearList.length - 1];

  const unitedStates = withinUnitedStates(bbox);
  const canada = withinCanada(bbox);
  if (!unitedStates && !canada) {
    notes.push(
      "Outside every registry wired up here. The fire and forest health registries this tool queries cover the United States and Canada. This area is outside both, so there is nothing to query. That is a gap in coverage, not an absence of disturbance, and a finding must not cite these datasets here.",
    );
    return result;
  }
  if (canada && !unitedStates) {
    notes.push(
      "Canadian coverage is fire only. Mapped fire comes from the National Burned Area Composite, which runs from 1972. There is no Canadian equivalent of the United States aerial insect and disease survey wired up here. An absence of insect damage here means it was not looked for.",
    );
  }

  const panes = ensurePanes(map);
  say("Querying the federal record.");

  const jobs = [
    { label: "the aerial forest health survey", run: (signal) => insectAndDisease(bbox, yearList, signal) },
    { label: "the fire registries", run: (signal) => fireEvidence(bbox, yearList, signal) },
    { label: "the Forest Service activity record", run: (signal) => managementRecord(bbox, yearList, signal) },
    { label: "the forest health survey shapes", run: (signal) => damageGeometry(bbox, yearList, signal) },
    { label: "the LANDFIRE catalogue", run: (signal) => landfireChoice(bbox, lastYear, signal) },
    { label: "the LCMS legends", run: (signal) => lcmsLegends(bbox, signal) },
  ];
  let finished = 0;
  const settled = await Promise.allSettled(
    jobs.map((job) =>
      attempt(job.run).finally(() => {
        finished += 1;
        say(`Checked ${job.label}, ${finished} of ${jobs.length}.`);
      }),
    ),
  );
  const [idsResult, firesResult, managementResult, shapesResult, landfireResult, lcmsResult] = settled;

  // Name each source that failed and say what happened to it.
  const unavailable = [
    ["ids", "the aerial forest health survey", idsResult],
    ["fire", "the fire registries", firesResult],
    ["management", "the Forest Service activity record", managementResult],
  ]
    .filter(([, , outcome]) => outcome.status === "rejected")
    .map(([key, label, outcome]) => ({ key, label, reason: describeError(outcome.reason) }));

  if (unavailable.length === 3) {
    notes.push(`The record could not be read. ${unavailable[0].reason}`);
    return result;
  }
  if (unavailable.length > 0) {
    notes.push(
      `Not every registry answered. Asked twice and still no answer from ${unavailable.map((entry) => `${entry.label} (${entry.reason})`).join("; ")}. Everything else here comes from the sources that did answer. An absence from one that failed is not evidence of absence on the ground, so search again before citing its silence in a finding.`,
    );
  }

  const ids =
    idsResult.status === "fulfilled" ? idsResult.value : { covered: false, groups: [], missing: [] };
  const idsFailed = unavailable.find((entry) => entry.key === "ids")?.reason ?? null;
  const fires =
    firesResult.status === "fulfilled"
      ? firesResult.value
      : { records: [], features: [], yearsUnassessed: [], sources: [] };
  const management = managementResult.status === "fulfilled" ? managementResult.value : null;

  // Mapped fire.
  if (fires.records.length === 0) {
    notes.push(
      `No mapped fire intersects this area in these years, according to ${fires.sources.join(", ") || "any registry that answered"}.`,
    );
  } else if (fires.sources.length > 1) {
    notes.push(
      `Answered by ${fires.sources.join(", ")}. The same fire may appear more than once with different outlines. An operational perimeter mapped during the incident is not the same measurement as a severity assessment mapped a season later. Quote one, and say which.`,
    );
  }
  if (fires.yearsUnassessed.length > 0) {
    const many = fires.yearsUnassessed.length !== 1;
    notes.push(
      `Some years are not yet assessed. Burn severity is mapped from imagery a year or more after a fire, so ${fires.yearsUnassessed.join(", ")} ${many ? "are" : "is"} not published yet. Absence here is not evidence that nothing burned.`,
    );
  }

  // Recorded management.
  if (management) {
    if (management.activities.length === 0) {
      notes.push(
        "No canopy-affecting silvicultural or fuels activity is recorded over this polygon for these years in FACTS, the Forest Service Activity Tracking System held in Natural Resource Manager. It was read from layer 0, Activity FACTS Common Attribute, of the Enterprise Data Warehouse map service EDW_ActivityFactsCommonAttributes_01. That service is published by the US Forest Service Enterprise Map Services Program. The query filters on completed activity by name to the regeneration, intermediate, salvage and fuels classes that open canopy. Stand examinations, prescriptions and certifications are deliberately excluded, so their absence here says nothing. FACTS is an administrative record of what a unit reported doing on National Forest System land, not a measurement of canopy and not a cadastre. Fee and state ownership, which carries most of the IFM estate, is outside its scope entirely. On those parcels this line is an absence of jurisdiction and cannot be cited as evidence that no harvest occurred.",
      );
    } else {
      notes.push(
        `${plural(management.activities.length, "completed canopy-affecting activity record", "completed canopy-affecting activity records")} came from FACTS layer 0, Activity FACTS Common Attribute, of EDW_ActivityFactsCommonAttributes_01. Each completion date is as the reporting unit entered it. This is an administrative record of what was done, not a measurement of what the canopy did. A delta over a stand FACTS records as treated inside the window is a reported treatment behaving as it should. The same delta with no record here, on National Forest System land where the record would exist, is the finding.`,
      );
    }
    if (management.undated > 0) {
      notes.push(
        `Activities with no completion date. ${plural(management.undated, "canopy-affecting record", "canopy-affecting records")} over this area ${management.undated === 1 ? "was" : "were"} entered without a completion date and could not be placed in a year. An activity entered but never closed out is a treatment of unknown status, not an absent one.`,
      );
    }
  }

  // Forest health survey. A failed query, an unsurveyed area and a clean
  // survey all arrive as an empty list, and they mean three different things.
  if (idsFailed) {
    notes.push(
      `The forest health survey was not read. This search could not read the aerial forest health survey (${idsFailed}). Nothing is known either way about pest or disease damage over this area. Search again; do not record this as an absence.`,
    );
  } else if (!ids.covered) {
    notes.push(
      "Outside the surveyed area. The aerial forest health survey covers the United States only, so nothing was asked about this area. That is an absence of jurisdiction, not an absence of damage.",
    );
  } else if (ids.groups.length === 0) {
    notes.push("The survey covers this area and recorded no damage over these years. That is a reading, not a gap.");
  } else {
    notes.push(
      "Polygons are stands the observer drew. Points are where they dropped a marker because the damage was too small to draw. Both are the survey's own records, sketch-mapped from an aircraft and approximate by construction. The survey layers draw the same records on the map, so each can be read against the stand the delta moved on.",
    );
  }
  if (ids.missing.length > 0) {
    const layer = ids.missing[0] === "area" ? "the sketched stands" : "the observation points";
    notes.push(
      ids.missing.length === 2
        ? "Only part of the survey was read. Neither survey layer answered, so nothing here comes from the aerial survey."
        : `Only part of the survey was read. The survey answered for one of its two layers but not for ${layer}, so any damage mapped that way is missing here. Search again before citing this as an absence.`,
    );
  }

  // Layers, fire first, one per registry in its own colour.
  for (const source of ["MTBS", "NIFC", "NBAC"]) {
    const features = fires.features.filter((feature) => feature.properties?.source === source);
    if (features.length === 0) continue;
    const style = FIRE_STYLE[source];
    const info = {
      MTBS: `${MTBS_ATTRIBUTION}. Burned area boundaries, one layer per year, from ${MTBS_SERVICE}. Burn severity is assessed from imagery a year or more after a fire, so the most recent season is often absent. Perimeters are generalised on the server and drawn for orientation, not measured.`,
      NIFC: `${NIFC_ATTRIBUTION}. Operational perimeters mapped during the incident, from ${NIFC_PERIMETERS}. They cover the years MTBS has not reached, but they are an operational product rather than a severity assessment.`,
      NBAC: `${NBAC_ATTRIBUTION}. The Canadian Forest Service equivalent of MTBS, running from 1972, from ${CWFIS_WFS}. The composite identifies fires by number, not name.`,
    }[source];
    layers.push({
      key: `ref-fire-${source.toLowerCase()}`,
      name: style.name,
      group: "Mapped fire",
      layer: fireLayer(source, features, panes.vector),
      legend: vectorLegend(style.name, style.color, "dashed"),
      info,
    });
  }

  // The survey's own shapes.
  if (shapesResult.status === "fulfilled") {
    const shapes = shapesResult.value;
    if (shapes.areas.features.length > 0) {
      const name = "Forest health survey, sketched stands";
      layers.push({
        key: "ref-ids-areas",
        name,
        group: "Forest health survey",
        layer: damageAreaLayer(shapes.areas, panes.vector),
        legend: vectorLegend(name, IDS_AREA_COLOUR, "fill"),
        info: `${IDS_ATTRIBUTION}, damage areas, layer 1 of ${IDS_SERVICE}. These are stands an aerial observer drew as damaged, by year, damage type and agent. They are sketch-mapped from an aircraft and approximate by construction.`,
      });
    }
    if (shapes.points.features.length > 0) {
      const name = "Forest health survey, observation points";
      layers.push({
        key: "ref-ids-points",
        name,
        group: "Forest health survey",
        layer: damagePointLayer(shapes.points, panes.vector),
        legend: vectorLegend(name, IDS_POINT_COLOUR, "point"),
        info: `${IDS_ATTRIBUTION}, damage points, layer 0 of ${IDS_SERVICE}. These are points an observer dropped where the damage was too small to draw, with a tree count where one was entered.`,
      });
    }
    if (shapes.failed.length > 0) {
      notes.push(`An overlay could not be drawn. The survey shapes did not load (${shapes.failed.join("; ")}).`);
    } else if (
      ids.groups.length > 0 &&
      shapes.areas.features.length === 0 &&
      shapes.points.features.length === 0
    ) {
      notes.push(
        "The survey returned no damage shapes over this area for these years. That is the survey's own silence, not a failed request.",
      );
    }
  } else if (unitedStates) {
    notes.push(`An overlay could not be drawn. ${describeError(shapesResult.reason)}`);
  }

  const leafletBounds = L.latLngBounds([bbox[1], bbox[0]], [bbox[3], bbox[2]]);

  // The independent change model.
  if (withinConus(bbox)) {
    const legends = lcmsResult.status === "fulfilled" && lcmsResult.value ? lcmsResult.value : [];
    LCMS_PRODUCTS.forEach((product, index) => {
      const name = product.timeEnabled ? `LCMS ${product.label}, ${lastYear}` : `LCMS ${product.label}`;
      // Landscape Change Monitoring System, the product's own image service
      // https://imagery.geoplatform.gov/iipp/rest/services/Vegetation
      const layer = exportTileLayer({
        url: product.service,
        endpoint: "exportImage",
        // Midyear, because the first of January sits between two annual rasters.
        params: product.timeEnabled ? { time: String(Date.UTC(lastYear, 6, 1)) } : {},
        bounds: leafletBounds,
        opacity: 0.75,
        attribution: LCMS_ATTRIBUTION,
        pane: panes.raster,
      });
      layers.push({
        key: `ref-lcms-${product.id}`,
        name,
        group: "Independent change model",
        layer,
        legend: rasterLegend(legends[index]),
        info: `${LCMS_ATTRIBUTION}, ${product.label}, from ${product.service}. ${product.description} ${LCMS_HINT}`,
      });
    });
  }

  // The disturbance cause.
  if (landfireRegion(bbox)) {
    if (landfireResult.status === "rejected") {
      notes.push(`An overlay could not be drawn. ${describeError(landfireResult.reason)}`);
    } else if (landfireResult.value && !landfireResult.value.service) {
      notes.push(
        "LANDFIRE publishes no disturbance product for this region at all, so there is nothing to draw. An absent product is not an absence of disturbance.",
      );
    } else if (landfireResult.value) {
      const { service, legend, asked } = landfireResult.value;
      let fallback = "";
      if (service.year !== asked) {
        fallback = `LANDFIRE has not published ${asked} yet, so the ${service.year} disturbance product is drawn instead. It lags the calendar by a year or more, and an absent product is not an absence of disturbance.`;
        notes.push(fallback);
      }
      // LANDFIRE annual disturbance, the chosen year's image service
      // https://lfps.usgs.gov/arcgis/rest/services/Landfire_Disturbance
      const layer = exportTileLayer({
        url: service.url,
        endpoint: "exportImage",
        // noData=0 leaves undisturbed ground transparent, which the service otherwise paints black.
        params: { noData: "0" },
        bounds: leafletBounds,
        opacity: 0.8,
        attribution: LANDFIRE_ATTRIBUTION,
        pane: panes.raster,
      });
      layers.push({
        key: "ref-landfire",
        name: `LANDFIRE disturbance, ${service.year}`,
        group: "Disturbance cause",
        layer,
        legend: rasterLegend(legend),
        info: `${LANDFIRE_ATTRIBUTION}, service ${service.name}, from ${service.url}. ${LANDFIRE_HINT}${fallback ? ` ${fallback}` : ""}`,
      });
    }
  }

  const attributions = [
    MTBS_ATTRIBUTION,
    management ? FACTS_ATTRIBUTION : null,
    landfireRegion(bbox) ? LANDFIRE_ATTRIBUTION : null,
    fires.sources.includes("NIFC") ? NIFC_ATTRIBUTION : null,
    fires.sources.includes("NBAC") ? NBAC_ATTRIBUTION : null,
    ids.covered ? IDS_ATTRIBUTION : null,
    withinConus(bbox) ? LCMS_ATTRIBUTION : null,
  ].filter(Boolean);
  notes.push(`${attributions.join(". ")}.`);

  records.fires = fires.records.map((fire) => ({ ...fire }));
  records.insects = ids.groups.map((group) => ({ ...group }));
  records.management = management ? management.activities.map((activity) => ({ ...activity })) : [];
  result.record = buildRecord({ years: yearList, fires, ids, idsFailed, management });

  say("The corroborating record is ready.");
  return result;
}
