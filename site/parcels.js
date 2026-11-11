// Parcel picker for the disturbance check page.
//
// Ported from the parcel lookup in disturbance-checker-srm 0.14.3, files
// src/parcels/states.ts, lookup.ts and panel.ts. A map click is sent to every
// statewide parcel service whose extent contains it, nearest state first.
// The first service that returns a parcel answers.
//
// The parcel's acres, and any other area, are never read or shown. That is a
// rule set by the project owner.
//
// Leaflet 1.9.4 must be loaded first as the global L. Leaflet-Geoman is
// optional, and while it is drawing, map clicks are left to it.

// ------------------------------------------------------------ services

// Statewide parcel services, one per state.
//
// The checker found and tested each layer on 2026-09-14. Each answered a point
// query from https://prototype-tools.github.io with a CORS header and GeoJSON
// output, and returned a parcel at a rural point inside the state.
//
// Thirteen publish an owner name. The others publish a parcel ID and, for some,
// an address, and the details say so rather than leaving the owner blank.
//
// Field names are the publisher's own. A null field is one the service does
// not carry. New Jersey carries OWNER_NAME, but every value was empty when the
// checker counted them, so it is null here.
const STATE_PARCEL_SERVICES = [
  {
    state: "MT",
    name: "Montana Cadastral Framework",
    url: "https://services.arcgis.com/qnjIrwR8z5Izc0ij/arcgis/rest/services/Montana_Cadastral_Framework/FeatureServer/1",
    page: "https://www.arcgis.com/home/item.html?id=f161a98b347b4cf29d371a6d7697912a",
    bbox: [-116.17857, 44.23772, -103.61113, 49.18074],
    fields: { owner: "OwnerName", parcelId: "PARCELID", address: "AddressLine1", county: "CountyName" },
    note: null,
  },
  {
    state: "WI",
    name: "Wisconsin Statewide Parcels DB",
    url: "https://services3.arcgis.com/n6uYoouQZW75n5WI/arcgis/rest/services/Wisconsin_Statewide_Parcels_DB/FeatureServer/0",
    page: "https://www.arcgis.com/home/item.html?id=2386813b23ea4e51a009f7d1d6b76e02",
    bbox: [-92.88863, 42.49192, -86.764, 47.08072],
    fields: { owner: "OWNERNME1", parcelId: "PARCELID", address: "SITEADRESS", county: "CONAME" },
    note: null,
  },
  {
    state: "NC",
    name: "North Carolina Parcels (Polygons)",
    url: "https://services.nconemap.gov/secure/rest/services/NC1Map_Parcels/MapServer/1",
    page: "https://www.arcgis.com/home/item.html?id=1de3d7d828ce4813b838ddf055b40317",
    bbox: [-84.50442, 33.73053, -75.36277, 37.81597],
    fields: { owner: "ownname", parcelId: "parno", address: "siteadd", county: "cntyname" },
    note: null,
  },
  {
    state: "VT",
    name: "VT Data - Statewide Standardized Parcel Data - parcel polygons",
    url: "https://services1.arcgis.com/BkFxaEFNwHqX3tAw/arcgis/rest/services/FS_VCGI_OPENDATA_Cadastral_VTPARCELS_poly_standardized_parcels_SP_v1/FeatureServer/0",
    page: "https://www.arcgis.com/home/item.html?id=09cf47e1cf82465e99164762a04f3ce6",
    bbox: [-73.45416, 42.72262, -71.46537, 45.01835],
    fields: { owner: "OWNER1", parcelId: "SPAN", address: "E911ADDR", county: null },
    note: null,
  },
  {
    state: "NJ",
    name: "Parcels and MOD-IV Composite of NJ, Web Mercator (3857)",
    url: "https://services2.arcgis.com/XVOqAjTOJ5P6ngMu/arcgis/rest/services/Parcels_Composite_NJ_WM/FeatureServer/0",
    page: "https://www.arcgis.com/home/item.html?id=533599bbfbaa4748bf39faf1375a8a9c",
    bbox: [-75.55957, 38.92466, -73.90245, 41.35689],
    fields: { owner: null, parcelId: "PAMS_PIN", address: "PROP_LOC", county: "COUNTY" },
    note: null,
  },
  {
    state: "CT",
    name: "Connecticut CAMA and Parcel Layer",
    url: "https://services3.arcgis.com/3FL1kr7L4LvwA2Kb/arcgis/rest/services/Connecticut_CAMA_and_Parcel_Layer/FeatureServer/0",
    page: "https://www.arcgis.com/home/item.html?id=82a733423a244c43a9d4bf552954cea9",
    bbox: [-73.74217, 40.97992, -71.78134, 42.05261],
    fields: { owner: "Owner", parcelId: "Parcel_ID", address: "Location", county: null },
    note: null,
  },
  {
    state: "WV",
    name: "WVParcels",
    url: "https://services.wvgis.wvu.edu/arcgis/rest/services/Planning_Cadastre/WV_Parcels/MapServer/0",
    page: null,
    bbox: [-82.70236, 37.16006, -77.6588, 40.63592],
    fields: { owner: "FullOwnerName", parcelId: "CleanParcelID", address: "FullPhysicalAddress", county: "COUNTY" },
    note: null,
  },
  {
    state: "CO",
    name: "Colorado Public Parcels",
    url: "https://gis.colorado.gov/public/rest/services/Address_and_Parcel/Colorado_Public_Parcels/FeatureServer/0",
    page: "https://www.arcgis.com/home/item.html?id=55234e04218f47c9868900e439fcbd5a",
    bbox: [-109.06017, 36.99197, -102.04665, 41.0033],
    fields: { owner: "owner", parcelId: "parcel_id", address: "situsAdd", county: "countyName" },
    note: null,
  },
  {
    state: "FL",
    name: "Florida_Statewide_Cadastral",
    url: "https://services9.arcgis.com/Gh9awoU677aKree0/arcgis/rest/services/Florida_Statewide_Cadastral/FeatureServer/0",
    page: "https://www.arcgis.com/home/item.html?id=64a6281f835c4b09a8abcc4e309230de",
    bbox: [-87.63799, 24.41173, -79.77018, 31.04262],
    fields: { owner: "OWN_NAME", parcelId: "PARCEL_ID", address: "PHY_ADDR1", county: "CO_NO" },
    note: "County is a county number, not a name.",
  },
  {
    state: "MA",
    name: "Massachusetts Property Tax Parcels",
    url: "https://services1.arcgis.com/hGdibHYSPO59RG1h/arcgis/rest/services/Massachusetts_Property_Tax_Parcels/FeatureServer/0",
    page: "https://www.arcgis.com/home/item.html?id=73d4c766167848b795f1048cad3919c7",
    bbox: [-73.53332, 41.23055, -69.89929, 42.88832],
    fields: { owner: "OWNER1", parcelId: "MAP_PAR_ID", address: "SITE_ADDR", county: null },
    note: null,
  },
  {
    state: "MN",
    name: "Parcels, Compiled from Opt-In Open Data Counties, Minnesota",
    url: "https://enterprise.gisdata.mn.gov/aghost/rest/services/us_mn_state_mngeo/plan_parcels_open/FeatureServer/1",
    page: "https://www.arcgis.com/home/item.html?id=69148d3959194a05a23964cc60f6517b",
    bbox: [-97.24526, 43.43615, -89.39721, 49.40315],
    fields: { owner: "owner_name", parcelId: "county_pin", address: null, county: "co_name" },
    note: "Opt-in counties only, not all 87.",
  },
  {
    state: "ID",
    name: "Public Idaho Parcels ",
    url: "https://services1.arcgis.com/CNPdEkvnGl65jCX8/arcgis/rest/services/Public_Idaho_Parcels_/FeatureServer/7",
    page: "https://www.arcgis.com/home/item.html?id=65a3f7c6d4ca404ba6ab677913953b35",
    bbox: [-117.37185, 41.96025, -110.80538, 46.66093],
    fields: { owner: "OWNER1", parcelId: "PARCEL_ID", address: "SITE_ADD", county: "County" },
    note: null,
  },
  {
    state: "AK",
    name: "Alaska Statewide Parcels",
    url: "https://services1.arcgis.com/7HDiw78fcUiM2BWn/arcgis/rest/services/AK_Parcels/FeatureServer/0",
    page: "https://www.arcgis.com/home/item.html?id=458be3d8aafa47cd882af05cee983f6b",
    bbox: [-166.84114, 53.80537, -129.99544, 71.38949],
    fields: { owner: "owner", parcelId: "parcel_id", address: null, county: "local_gov" },
    note: null,
  },
  {
    state: "AR",
    name: "PARCEL_POLYGON_CAMP",
    url: "https://gis.arkansas.gov/arcgis/rest/services/FEATURESERVICES/Planning_Cadastre/FeatureServer/6",
    page: null,
    bbox: [-94.61829, 32.9693, -89.62164, 36.53177],
    fields: { owner: "ownername", parcelId: "parcelid", address: "adrlabel", county: "county" },
    note: null,
  },
  {
    state: "IN",
    name: "Parcel Boundaries of Indiana Current",
    url: "https://gisdata.in.gov/server/rest/services/Hosted/Parcel_Boundaries_of_Indiana_Current/FeatureServer/0",
    page: "https://www.arcgis.com/home/item.html?id=70565d886f1e4528a43a86be6ce5c2f3",
    bbox: [-88.09731, 37.77247, -84.78565, 41.76068],
    fields: { owner: null, parcelId: "state_parcel_id", address: "prop_add", county: "tax_county" },
    note: null,
  },
  {
    state: "DE",
    name: "Delaware State Parcels 2.0",
    url: "https://enterprise.firstmap.delaware.gov/arcgis/rest/services/PlanningCadastre/DE_StateParcels/MapServer/0",
    page: "https://www.arcgis.com/home/item.html?id=07c0da8c59a64735aab71bf38dacf393",
    bbox: [-75.78901, 38.45075, -75.04944, 39.83954],
    fields: { owner: null, parcelId: "PIN", address: null, county: "COUNTY" },
    note: null,
  },
  {
    state: "VA",
    name: "Virginia Parcels (Map Service)",
    url: "https://vginmaps.vdem.virginia.gov/arcgis/rest/services/VA_Base_Layers/VA_Parcels/MapServer/0",
    page: "https://www.arcgis.com/home/item.html?id=d0945119ac1d44398b662c21f74d8080",
    bbox: [-83.67542, 36.53738, -75.23945, 39.46403],
    fields: { owner: null, parcelId: "PARCELID", address: null, county: "LOCALITY" },
    note: null,
  },
  {
    state: "WA",
    name: "Current Parcels",
    url: "https://services.arcgis.com/jsIt88o09Q0r1j8h/arcgis/rest/services/Current_Parcels/FeatureServer/0",
    page: "https://www.arcgis.com/home/item.html?id=2b603a599a0842a3b2284c04c8927f35",
    bbox: [-124.92672, 45.4856, -116.71092, 49.04933],
    fields: { owner: null, parcelId: "PARCEL_ID_NR", address: "SITUS_ADDRESS", county: "COUNTY_NM" },
    note: null,
  },
  {
    state: "OH",
    name: "Ohio Statewide Parcels Public View",
    url: "https://services2.arcgis.com/MlJ0G8iWUyC7jAmu/arcgis/rest/services/OhioStatewidePacels_full_view/FeatureServer/0",
    page: "https://www.arcgis.com/home/item.html?id=26ab5fad8d5d4258a7492a14de83bc0e",
    bbox: [-84.91891, 38.37998, -80.47957, 41.99351],
    fields: { owner: null, parcelId: "StateParcelID", address: "SitusAddressAll", county: "County" },
    note: null,
  },
  {
    state: "CA",
    name: "California Statewide Parcels Public View",
    url: "https://bz1uwWPKUInZBK94.svcs5.arcgis.com/bz1uwWPKUInZBK94/arcgis/rest/services/CA_Statewide_Parcels_Public_view/FeatureServer/0",
    page: "https://www.arcgis.com/home/item.html?id=2061fbc963464c5198ec064100802624",
    bbox: [-125.00229, 32.38023, -113.34932, 42.14545],
    fields: { owner: null, parcelId: "PARCEL_APN", address: "SITE_ADDR", county: "COUNTYNAME" },
    note: null,
  },
  {
    state: "ND",
    name: "NDGISHUB Parcels",
    url: "https://services1.arcgis.com/GOcSXpzwBHyk2nog/arcgis/rest/services/NDGISHUB_Parcels/FeatureServer/0",
    page: "https://www.arcgis.com/home/item.html?id=ac6da1176038457db16e8debe3f1abaf",
    bbox: [-104.04909, 45.93498, -96.55453, 49.0005],
    fields: { owner: null, parcelId: "UniqueGISID", address: null, county: "CountyName" },
    note: null,
  },
];

const COVERED_STATES = STATE_PARCEL_SERVICES.map((service) => service.state).sort();
const OWNER_STATES = STATE_PARCEL_SERVICES.filter((service) => service.fields.owner)
  .map((service) => service.state)
  .sort();

// --------------------------------------------------------------- lookup

// Extents overlap along borders, so a click near one is tried in both states.
// A service that answers with an ArcGIS error is tried once more after a
// pause. North Dakota returned "Unable to perform query" to identical requests
// that succeeded minutes later when the checker tested it on 2026-09-14.

// An error this module raised itself, whose message already names the state.
class ServiceError extends Error {}

function servicesAt(lon, lat) {
  return STATE_PARCEL_SERVICES
    .filter(({ bbox: [w, s, e, n] }) => lon >= w && lon <= e && lat >= s && lat <= n)
    .sort((a, b) => centreDistance(a, lon, lat) - centreDistance(b, lon, lat));
}

function centreDistance(service, lon, lat) {
  const [w, s, e, n] = service.bbox;
  return Math.hypot((w + e) / 2 - lon, (s + n) / 2 - lat);
}

function text(value) {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed === "" ? null : trimmed;
}

async function query(service, lon, lat, signal) {
  const params = new URLSearchParams({
    geometry: `${lon},${lat}`,
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields: "*",
    returnGeometry: "true",
    outSR: "4326",
    f: "geojson",
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    // Reads one of these statewide parcel datasets, the one in service.url.
    // Each line gives the dataset's name, its state and its item page, or its service where no item page exists.
    // Montana Cadastral Framework, MT, https://www.arcgis.com/home/item.html?id=f161a98b347b4cf29d371a6d7697912a
    // Wisconsin Statewide Parcels DB, WI, https://www.arcgis.com/home/item.html?id=2386813b23ea4e51a009f7d1d6b76e02
    // North Carolina Parcels (Polygons), NC, https://www.arcgis.com/home/item.html?id=1de3d7d828ce4813b838ddf055b40317
    // VT Data - Statewide Standardized Parcel Data - parcel polygons, VT, https://www.arcgis.com/home/item.html?id=09cf47e1cf82465e99164762a04f3ce6
    // Parcels and MOD-IV Composite of NJ, Web Mercator (3857), NJ, https://www.arcgis.com/home/item.html?id=533599bbfbaa4748bf39faf1375a8a9c
    // Connecticut CAMA and Parcel Layer, CT, https://www.arcgis.com/home/item.html?id=82a733423a244c43a9d4bf552954cea9
    // WVParcels, WV, https://services.wvgis.wvu.edu/arcgis/rest/services/Planning_Cadastre/WV_Parcels/MapServer/0
    // Colorado Public Parcels, CO, https://www.arcgis.com/home/item.html?id=55234e04218f47c9868900e439fcbd5a
    // Florida_Statewide_Cadastral, FL, https://www.arcgis.com/home/item.html?id=64a6281f835c4b09a8abcc4e309230de
    // Massachusetts Property Tax Parcels, MA, https://www.arcgis.com/home/item.html?id=73d4c766167848b795f1048cad3919c7
    // Parcels, Compiled from Opt-In Open Data Counties, Minnesota, MN, https://www.arcgis.com/home/item.html?id=69148d3959194a05a23964cc60f6517b
    // Public Idaho Parcels, ID, https://www.arcgis.com/home/item.html?id=65a3f7c6d4ca404ba6ab677913953b35
    // Alaska Statewide Parcels, AK, https://www.arcgis.com/home/item.html?id=458be3d8aafa47cd882af05cee983f6b
    // PARCEL_POLYGON_CAMP, AR, https://gis.arkansas.gov/arcgis/rest/services/FEATURESERVICES/Planning_Cadastre/FeatureServer/6
    // Parcel Boundaries of Indiana Current, IN, https://www.arcgis.com/home/item.html?id=70565d886f1e4528a43a86be6ce5c2f3
    // Delaware State Parcels 2.0, DE, https://www.arcgis.com/home/item.html?id=07c0da8c59a64735aab71bf38dacf393
    // Virginia Parcels (Map Service), VA, https://www.arcgis.com/home/item.html?id=d0945119ac1d44398b662c21f74d8080
    // Current Parcels, WA, https://www.arcgis.com/home/item.html?id=2b603a599a0842a3b2284c04c8927f35
    // Ohio Statewide Parcels Public View, OH, https://www.arcgis.com/home/item.html?id=26ab5fad8d5d4258a7492a14de83bc0e
    // California Statewide Parcels Public View, CA, https://www.arcgis.com/home/item.html?id=2061fbc963464c5198ec064100802624
    // NDGISHUB Parcels, ND, https://www.arcgis.com/home/item.html?id=ac6da1176038457db16e8debe3f1abaf
    const response = await fetch(`${service.url}/query?${params}`, { signal });
    if (!response.ok) throw new ServiceError(`${service.state} answered HTTP ${response.status}`);
    const body = await response.json();
    if (body.error) {
      if (attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        continue;
      }
      throw new ServiceError(`${service.state} returned the error "${body.error.message ?? "query failed"}"`);
    }
    const feature = body.features?.[0];
    if (!feature) return null;
    const properties = feature.properties ?? {};
    const pick = (field) => (field ? text(properties[field]) : null);
    return {
      service,
      owner: pick(service.fields.owner),
      parcelId: pick(service.fields.parcelId),
      address: pick(service.fields.address),
      county: pick(service.fields.county),
      geometry: feature.geometry ?? null,
    };
  }
  return null;
}

async function lookUpParcel(lon, lat, signal) {
  const tried = [];
  const errors = [];
  for (const service of servicesAt(lon, lat)) {
    tried.push(service.state);
    try {
      const result = await query(service, lon, lat, signal);
      if (result) return { result, tried, errors };
    } catch (error) {
      if (signal.aborted) throw error;
      const message = error instanceof Error ? error.message : String(error);
      errors.push(error instanceof ServiceError ? message : `${service.state} could not be read (${message})`);
    }
  }
  return { result: null, tried, errors };
}

// ---------------------------------------------------------------- style

const STYLE_ID = "parcelpick-style";

const STYLE = `
.parcelpick { display: grid; gap: 8px; }
.parcelpick p { margin: 0; }
.parcelpick-intro { color: var(--muted); font-size: 13px; }
.parcelpick button { font: inherit; border: 1px solid var(--line); background: var(--bg); color: var(--ink); border-radius: 6px; padding: 6px 10px; cursor: pointer; }
.parcelpick button:hover { border-color: var(--accent); }
.parcelpick button[aria-pressed="true"], .parcelpick button.parcelpick-use { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); font-weight: 600; }
.parcelpick-status { font-size: 13px; }
.parcelpick-status:empty, .parcelpick-result:empty { display: none; }
.parcelpick-status.parcelpick-warn { background: var(--warn-bg); border: 1px solid var(--warn-line); border-radius: 6px; padding: 6px 8px; }
.parcelpick-result { display: grid; gap: 6px; border: 1px solid var(--line); border-radius: 6px; padding: 8px; background: var(--panel); }
.parcelpick-heading { font-weight: 600; overflow-wrap: anywhere; }
.parcelpick-table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 13px; }
.parcelpick-table th, .parcelpick-table td { text-align: left; vertical-align: top; padding: 4px 6px; border-bottom: 1px solid var(--line); overflow-wrap: anywhere; }
.parcelpick-table th { width: 32%; color: var(--muted); font-weight: 600; }
.parcelpick-none { color: var(--muted); }
.parcelpick-note { color: var(--muted); font-size: 13px; }
.parcelpick a { color: var(--accent); }
.parcelpick-buttons { display: flex; flex-wrap: wrap; gap: 8px; }
`;

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = STYLE;
  document.head.append(style);
}

// --------------------------------------------------------------- picker

const PICK_LABEL = "Pick a parcel on the map";
const STOP_LABEL = "Stop picking";

// Puts a "Pick a parcel on the map" button and a status line in the container
// element. After the button, the next map click queries the state services,
// draws the parcel outline on the map, and shows its details.
//
// A "Use as boundary" button then calls onPick(feature, label). The feature is
// a GeoJSON Feature with a Polygon or MultiPolygon in degrees. The label is a
// short description, such as "Parcel 12-3456 (MT)".
//
// The feature's properties hold the parcel ID, county, address, state and
// source, and nothing else. The outline is removed once the parcel is handed
// over, because the page draws its own boundary.
//
// Returns { cancel(), clear() }. cancel() stops waiting for a click and stops a
// lookup in flight. clear() does that and also removes the outline and details.
export function createParcelPicker(map, container, onPick) {
  const L = globalThis.L;
  injectStyle();

  let waiting = false;
  let controller = null;
  let outline = null;

  const root = document.createElement("div");
  root.className = "parcelpick";

  const intro = document.createElement("p");
  intro.className = "parcelpick-intro";
  intro.textContent =
    "Press the button, then click the map to look up the parcel there. " +
    `Statewide parcel services are published by ${COVERED_STATES.length} states. ` +
    `These are ${COVERED_STATES.join(", ")}. ` +
    `Owner names come from ${OWNER_STATES.length} of them (${OWNER_STATES.join(", ")}). ` +
    "The rest give a parcel ID and, for some, an address.";

  const pickButton = document.createElement("button");
  pickButton.type = "button";
  pickButton.textContent = PICK_LABEL;
  pickButton.setAttribute("aria-pressed", "false");

  const status = document.createElement("p");
  status.className = "parcelpick-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");

  const result = document.createElement("div");
  result.className = "parcelpick-result";

  root.append(intro, pickButton, status, result);
  container.append(root);

  function setStatus(message, warn = false) {
    status.textContent = message;
    status.classList.toggle("parcelpick-warn", warn);
  }

  // True while Leaflet-Geoman is drawing or removing shapes, when map clicks
  // belong to it.
  function geomanBusy() {
    const pm = map.pm;
    if (!pm) return false;
    const drawing = typeof pm.globalDrawModeEnabled === "function" && pm.globalDrawModeEnabled();
    const removing = typeof pm.globalRemovalModeEnabled === "function" && pm.globalRemovalModeEnabled();
    return Boolean(drawing || removing);
  }

  function removeOutline() {
    if (outline) {
      map.removeLayer(outline);
      outline = null;
    }
  }

  function abortLookup() {
    if (controller) {
      controller.abort();
      controller = null;
    }
  }

  function stopWaiting() {
    if (!waiting) return;
    waiting = false;
    map.off("click", onMapClick);
    map.off("pm:drawstart", onDrawStart);
    map.getContainer().style.cursor = "";
    pickButton.textContent = PICK_LABEL;
    pickButton.setAttribute("aria-pressed", "false");
  }

  function startWaiting() {
    if (geomanBusy()) {
      setStatus("Finish or cancel the drawing first, then pick a parcel.", true);
      return;
    }
    abortLookup();
    waiting = true;
    map.on("click", onMapClick);
    map.on("pm:drawstart", onDrawStart);
    map.getContainer().style.cursor = "crosshair";
    pickButton.textContent = STOP_LABEL;
    pickButton.setAttribute("aria-pressed", "true");
    setStatus("Click the map to look up the parcel there.");
  }

  function cancel() {
    const busy = waiting || controller !== null;
    stopWaiting();
    abortLookup();
    if (busy) setStatus("The parcel pick was cancelled.");
  }

  function clear() {
    stopWaiting();
    abortLookup();
    removeOutline();
    result.replaceChildren();
    setStatus("");
  }

  function onDrawStart() {
    stopWaiting();
    setStatus("The parcel pick was cancelled because drawing started.");
  }

  function onMapClick(event) {
    if (geomanBusy()) return;
    stopWaiting();
    const { lat, lng } = event.latlng.wrap();
    lookUp(lng, lat);
  }

  async function lookUp(lon, lat) {
    abortLookup();
    const ctrl = new AbortController();
    controller = ctrl;
    removeOutline();
    result.replaceChildren();
    const where = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
    setStatus(`Looking up ${where}…`);
    try {
      const { result: parcel, tried, errors } = await lookUpParcel(lon, lat, ctrl.signal);
      if (ctrl.signal.aborted) return;
      controller = null;
      if (!parcel) {
        if (!tried.length) {
          setStatus(`No statewide parcel service covers ${where}.`);
        } else {
          const failures = errors.length ? ` ${errors.join(". ")}.` : "";
          setStatus(`No parcel returned at ${where} by ${tried.join(", ")}.${failures}`, errors.length > 0);
        }
        return;
      }
      showParcel(parcel);
    } catch (error) {
      if (ctrl.signal.aborted) return;
      controller = null;
      setStatus(`The lookup failed. ${error instanceof Error ? error.message : String(error)}`, true);
    }
  }

  function addRow(table, name, value) {
    const row = table.insertRow();
    const head = document.createElement("th");
    head.scope = "row";
    head.textContent = name;
    row.append(head);
    const cell = row.insertCell();
    if (value instanceof Node) {
      cell.append(value);
    } else if (value === null) {
      cell.textContent = "not published";
      cell.className = "parcelpick-none";
    } else {
      cell.textContent = value;
    }
  }

  function link(href, words) {
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.target = "_blank";
    anchor.rel = "noopener";
    anchor.textContent = words;
    return anchor;
  }

  function showParcel(parcel) {
    const { service } = parcel;
    const geometry = parcel.geometry;
    const isPolygon = Boolean(geometry) && (geometry.type === "Polygon" || geometry.type === "MultiPolygon");
    const label = `Parcel ${parcel.parcelId ?? ""} (${service.state})`.replace("  ", " ");
    const feature = {
      type: "Feature",
      geometry,
      properties: {
        parcelId: parcel.parcelId,
        county: parcel.county,
        address: parcel.address,
        state: service.state,
        source: service.name.trim(),
        sourceUrl: service.url,
      },
    };

    const heading = document.createElement("p");
    heading.className = "parcelpick-heading";
    heading.textContent = `${service.name.trim()} (${service.state})`;

    const table = document.createElement("table");
    table.className = "parcelpick-table";
    addRow(table, "Owner", service.fields.owner ? parcel.owner : "this state publishes no owner name");
    addRow(table, "Parcel ID", parcel.parcelId);
    addRow(table, "Address", parcel.address);
    addRow(table, "County", parcel.county);
    addRow(table, "State", service.state);
    const source = document.createDocumentFragment();
    source.append(link(service.url, "state service"));
    if (service.page) source.append(", ", link(service.page, "item page"));
    addRow(table, "Source", source);

    result.append(heading, table);
    if (service.note) {
      const note = document.createElement("p");
      note.className = "parcelpick-note";
      note.textContent = service.note;
      result.append(note);
    }

    const buttons = document.createElement("div");
    buttons.className = "parcelpick-buttons";
    if (isPolygon) {
      const use = document.createElement("button");
      use.type = "button";
      use.className = "parcelpick-use";
      use.textContent = "Use as boundary";
      use.addEventListener("click", () => {
        removeOutline();
        use.remove();
        onPick(feature, label);
        setStatus(`${label} is now the boundary.`);
      });
      buttons.append(use);
    }
    const clearButton = document.createElement("button");
    clearButton.type = "button";
    clearButton.textContent = "Clear outline";
    clearButton.addEventListener("click", clear);
    buttons.append(clearButton);
    result.append(buttons);

    if (isPolygon) {
      outline = L.geoJSON(feature, {
        style: { color: "#ffd400", weight: 2.5, fill: false },
        interactive: false,
        pmIgnore: true,
      }).addTo(map);
      setStatus("");
    } else {
      setStatus("The service returned no polygon for this parcel, so it cannot be used as a boundary.", true);
    }
  }

  pickButton.addEventListener("click", () => {
    if (waiting) cancel();
    else startWaiting();
  });

  return { cancel, clear };
}
