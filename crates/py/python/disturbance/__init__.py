"""The canopy disturbance check, in place of the Earth Engine API.

The same method as the disturbance-rust web page and terminal program,
compiled from the same Rust. It runs on this machine: it finds Sentinel-2
or Sentinel-1 scenes in a public catalogue, reads only the pixels inside
the boundary's box, and composites, differences and classifies them here.
No account and no sign-in.

    import disturbance as dc

    run = dc.check("Project_Boundary.shp",
                   pre=("2024-08-01", "2024-09-01"),
                   post=("2025-08-01", "2025-09-01"),
                   label="RP1")
    run.add_to_map()          # ArcGIS Pro: layers in the active map
    run.plot_histograms()     # the SOP's histogram check
    run.save("outputs")       # GeoTIFFs, flagged patches, run record

Arrays are on the run's UTM grid at 20 m: `run.deltas`, `run.classes`
and `run.backdrops`, with `run.epsg` and `run.transform` to place them.
"""

import csv
import json
import os
import sys
import tempfile
import time

import numpy as np

from . import _core

__version__ = _core.__version__

#: The SOP's thresholds, low, moderate and high, as the Rust core holds them.
SOP_BREAKS = {
    "dNDVI": (0.10, 0.20, 0.35),
    "dNDMI": (0.15, 0.30, 0.45),
    "dNBR": (0.10, 0.27, 0.44),
    "dVH": (2.0, 2.5, 3.5),
}

#: What each change means, for layer names.
MEANINGS = {
    "dNDVI": "Canopy Loss",
    "dNDMI": "Moisture Stress",
    "dNBR": "Burn Severity",
    "dVH": "Radar Canopy Loss",
}

_HOSTS = {"earth-search": "earth-search", "planetary-computer": "planetary-computer"}
_SENSORS = {"optical": "sentinel-2", "sentinel-2": "sentinel-2", "radar": "sentinel-1", "sentinel-1": "sentinel-1"}


# The boundary -------------------------------------------------------------

def boundary(source):
    """The boundary as the Rust core takes it.

    `source` may be a box (west, south, east, north) in degrees, a GeoJSON
    dict, a .geojson file, or anything ArcGIS Pro can read as features: a
    shapefile, a geodatabase feature class or a layer in the map. Pro
    reprojects it to WGS84 on the way out.
    """
    if isinstance(source, dict) and source.get("kind") in ("rectangle", "geojson"):
        return source
    if isinstance(source, (tuple, list)) and len(source) == 4 and all(isinstance(v, (int, float)) for v in source):
        return {"kind": "rectangle", "bbox": [float(v) for v in source]}
    if isinstance(source, dict):
        return {"kind": "geojson", "geometry": source}
    path = os.fspath(source)
    if path.lower().endswith((".geojson", ".json")) and os.path.isfile(path):
        with open(path, encoding="utf-8") as fh:
            return {"kind": "geojson", "geometry": json.load(fh)}
    try:
        import arcpy
    except ImportError:
        raise ValueError(
            "{} needs ArcGIS Pro to read. Outside Pro, give a .geojson file, "
            "a GeoJSON dict or a box.".format(path)) from None
    if arcpy.Describe(path).spatialReference.name == "Unknown":
        raise ValueError("The boundary has no coordinate system. Define one in Pro first.")
    stem = os.path.join(arcpy.env.scratchFolder, "_disturbance_boundary")
    for p in (stem + ".json", stem + ".geojson"):
        if os.path.exists(p):
            os.remove(p)
    arcpy.conversion.FeaturesToJSON(path, stem + ".geojson", geoJSON="GEOJSON", outputToWGS84="WGS84")
    written = next(p for p in (stem + ".geojson", stem + ".json") if os.path.isfile(p))
    with open(written, encoding="utf-8") as fh:
        return {"kind": "geojson", "geometry": json.load(fh)}


# Running ------------------------------------------------------------------

def _breaks_json(breaks):
    out = {}
    for name, value in (breaks or {}).items():
        if isinstance(value, dict):
            low, moderate, high = value["low"], value["moderate"], value["high"]
        else:
            low, moderate, high = value
        out[name] = {"low": float(low), "moderate": float(moderate), "high": float(high)}
    return out


class _Progress:
    """One line in the notebook, rewritten as the run goes."""

    def __init__(self):
        self.start = time.time()
        self.last = ""

    def __call__(self, message, fraction):
        line = "{:3.0f}%  {}  ({:.0f} s)".format(100 * fraction, message, time.time() - self.start)
        sys.stdout.write("\r" + line.ljust(len(self.last)))
        sys.stdout.flush()
        self.last = line

    def done(self):
        sys.stdout.write("\n")
        sys.stdout.flush()


def check(boundary_source, pre, post, label="", sensor="optical", breaks=None,
          normalise=True, max_cloud=30, host="earth-search", coarse_read=False,
          concurrency=12, progress=True):
    """Run one reporting period and return a `Run`.

    `pre` and `post` are (start, end) date pairs, ISO text. `breaks` maps a
    change to (low, moderate, high); a change left out keeps the SOP's.
    `normalise` lets a dry summer's shift of the unchanged forest move the
    breaks, as the web page does; set it False to classify at the breaks as
    given, as the Earth Engine notebook did.
    """
    params = {
        "aoi": boundary(boundary_source),
        "pre_start": pre[0], "pre_end": pre[1],
        "post_start": post[0], "post_end": post[1],
        "host": _HOSTS[host],
        "sensor": _SENSORS[sensor],
        "normalise": bool(normalise),
        "max_cloud": float(max_cloud),
        "coarse_read": bool(coarse_read),
        "concurrency": int(concurrency),
        "breaks": _breaks_json(breaks),
        "label": label,
    }
    reporter = _Progress() if progress else None
    try:
        core = _core.run(json.dumps(params), reporter)
    finally:
        if reporter:
            reporter.done()
    run = Run(core, label or "Period", params)
    for warning in run.warnings:
        print("warning: " + warning)
    return run


# The result ---------------------------------------------------------------

class Run:
    """One finished check, with its arrays on the run's UTM grid."""

    def __init__(self, core, label, params):
        self._core = core
        self.label = label
        self.params = params
        epsg, x0, y0, res, width, height = core.grid()
        self.epsg = epsg
        self.shape = (height, width)
        self.resolution = res
        #: Affine transform, as GDAL orders it: x0, pixel width, 0, y0, 0, -pixel height.
        self.transform = (x0, res, 0.0, y0, 0.0, -res)
        #: West, south, east, north in the grid's metres.
        self.extent = (x0, y0 - height * res, x0 + width * res, y0)
        self.deltas = {name: np.frombuffer(b, dtype="<f4").reshape(self.shape) for name, b in core.deltas()}
        self.backdrops = {
            key: np.stack([np.frombuffer(b, dtype="<f4").reshape(self.shape) for b in bands])
            for key, _name, bands in core.backdrops()
        }
        self._load()

    def _load(self):
        self.record = json.loads(self._core.record())
        self.classes = {name: np.frombuffer(b, dtype=np.uint8).reshape(self.shape) for name, b in self._core.classes()}
        self.breaks = {d["id"]: (d["breaks_used"]["low"], d["breaks_used"]["moderate"], d["breaks_used"]["high"])
                       for d in self.record["deltas"]}
        self.histograms = {d["id"]: (np.array(d["histogram"]["starts"]), np.array(d["histogram"]["counts"]))
                           for d in self.record["deltas"]}
        self.warnings = list(self.record["warnings"])
        self.diagnostics = list(self.record["diagnostics"])
        self.patches = list(self.record["patches"])

    def __repr__(self):
        return "<disturbance.Run {} EPSG:{} {}x{} px, {} patches>".format(
            self.label, self.epsg, self.shape[1], self.shape[0], len(self.patches))

    def reclassify(self, breaks, normalise=None):
        """Draw the classes again at new breaks, with nothing downloaded."""
        if normalise is None:
            normalise = self.params["normalise"]
        self._core.reclassify(json.dumps(_breaks_json(breaks)), bool(normalise))
        self._load()
        return self

    def summary(self):
        """One row per change: breaks used, pixels in each class, patches.
        A pandas DataFrame when pandas is installed, else a list of dicts."""
        rows = []
        for d in self.record["deltas"]:
            c = self.classes[d["id"]]
            low, mod, high = self.breaks[d["id"]]
            rows.append({
                "period": self.label, "change": d["id"], "meaning": d["meaning"],
                "low_break": round(low, 4), "moderate_break": round(mod, 4), "high_break": round(high, 4),
                "shift_applied": bool(self.params["normalise"] and d["normalisation"]["applicable"]),
                "low_px": int((c == 1).sum()), "moderate_px": int((c == 2).sum()), "high_px": int((c == 3).sum()),
                "patches": d["patches_total"],
            })
        try:
            import pandas as pd
            return pd.DataFrame(rows)
        except ImportError:
            return rows

    # Files ----------------------------------------------------------------

    def save(self, folder, prefix=None):
        """Write the GeoTIFFs, flagged-patches.csv and run-record.json to
        `folder`, each name starting with the period's label. Returns the
        paths by key."""
        prefix = self.label if prefix is None else prefix
        os.makedirs(folder, exist_ok=True)
        paths = {}
        for name, data in self._core.geotiffs():
            path = os.path.join(folder, "{}_{}".format(prefix, name) if prefix else name)
            with open(path, "wb") as fh:
                fh.write(data)
            paths[name[:-4]] = path
        patches = os.path.join(folder, "{}_flagged-patches.csv".format(prefix) if prefix else "flagged-patches.csv")
        with open(patches, "w", newline="", encoding="utf-8") as fh:
            writer = csv.writer(fh)
            writer.writerow(["period", "change", "meaning", "class", "latitude", "longitude", "peak_value",
                             "pre_window", "post_window"])
            for p in self.patches:
                writer.writerow([self.label, p["delta"], MEANINGS.get(p["delta"], ""),
                                 "high" if p["class"] == 3 else "moderate",
                                 "{:.6f}".format(p["lat"]), "{:.6f}".format(p["lon"]), "{:.3f}".format(p["peak"]),
                                 "{}/{}".format(self.params["pre_start"], self.params["pre_end"]),
                                 "{}/{}".format(self.params["post_start"], self.params["post_end"])])
        paths["flagged-patches"] = patches
        record = os.path.join(folder, "{}_run-record.json".format(prefix) if prefix else "run-record.json")
        with open(record, "w", encoding="utf-8") as fh:
            json.dump(dict(self.record, settings={k: v for k, v in self.params.items() if k != "aoi"}), fh, indent=2)
        paths["run-record"] = record
        return paths

    # ArcGIS Pro -----------------------------------------------------------

    def add_to_map(self, map=None, folder=None, classes_visible=True, backdrops=True,
                   changes=True, backdrops_visible=False, changes_visible=False):
        """Add the run's layers to a map in ArcGIS Pro, the active map by
        default, replacing any of the same name: the before and after
        pictures and the continuous changes, both switched off, then the
        classes. `backdrops` and `changes` set False leave those out. The
        files go to `folder`, a DisturbanceCheck folder in Pro's scratch
        folder by default."""
        import arcpy
        if map is None:
            aprx = arcpy.mp.ArcGISProject("CURRENT")
            map = aprx.activeMap or aprx.listMaps()[0]
        if folder is None:
            folder = os.path.join(arcpy.env.scratchFolder or tempfile.gettempdir(), "DisturbanceCheck")
        paths = self.save(folder)
        order = []
        for key in (self.backdrops if backdrops else ()):
            name = "{} {}".format(self.label, "Pre RGB" if key.startswith("pre") else "Post RGB")
            if key.endswith("vh"):
                name = "{} {}".format(self.label, "Pre VH" if key.startswith("pre") else "Post VH")
            order.append((paths[key], name, backdrops_visible))
        for change in (self.deltas if changes else ()):
            order.append((paths[change + "-change"], "{} {} continuous".format(self.label, change), changes_visible))
        for change in self.deltas:
            order.append((paths[change + "-classes"],
                          "{} {} - {} [Low/Mod/High]".format(self.label, change, MEANINGS[change]), classes_visible))
        added = []
        for path, name, visible in order:
            for layer in map.listLayers():
                if layer.name == name:
                    map.removeLayer(layer)
            layer = map.addDataFromPath(path)
            layer.name = name
            layer.visible = visible
            added.append(layer)
        return added

    # Plots ----------------------------------------------------------------

    def plot_histograms(self, folder=None, lines=None):
        """The SOP's histogram of each change, with the breaks as dashed
        lines. `lines` maps a change to the lines to draw, the breaks used
        by default. Saved to `folder` when given."""
        import matplotlib.pyplot as plt
        for change, (starts, counts) in self.histograms.items():
            width = starts[1] - starts[0] if len(starts) > 1 else 0.01
            plt.figure(figsize=(11, 4))
            plt.bar(starts + width / 2, counts, width=width, color="steelblue")
            for x, colour, label in zip((lines or {}).get(change, self.breaks[change]),
                                        ("orange", "red", "darkred"), ("Low", "Mod", "High")):
                plt.axvline(x, color=colour, lw=1.2, linestyle="--", label=label)
            plt.xlabel("{} value".format(change))
            plt.ylabel("Pixel count")
            plt.title("{} pixel distribution, {}".format(change, self.label))
            plt.legend()
            plt.tight_layout()
            if folder:
                os.makedirs(folder, exist_ok=True)
                plt.savefig(os.path.join(folder, "{}_{}_histogram.png".format(self.label, change)), dpi=150)
            plt.show()
