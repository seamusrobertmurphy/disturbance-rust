"""Can a web page, with no account, search each catalogue and read pixels from it?

For each collection: one STAC search at 44.0 N, 122.5 W in August 2025 (2023 for
Landsat on USGS, which may lag), then a 1 KB range read of one band asset, both
sent with an Origin header as a browser would. Reports the status and whether the
reply carries access-control-allow-origin, which a browser needs to read it.
"""
import json
import urllib.error
import urllib.request

ORIGIN = "https://example.org"
UA = "stac-probe/0.1"
POINT = [-122.5, 44.0, -122.49, 44.01]


def request(url, method="GET", body=None, headers=None):
    h = {"Origin": ORIGIN, "User-Agent": UA, **(headers or {})}
    data = json.dumps(body).encode() if body is not None else None
    if data:
        h["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            return r.status, dict(r.headers), r.read(400_000)
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read(2000)
    except Exception as e:  # noqa: BLE001
        return None, {}, str(e).encode()


def acao(headers):
    for k, v in headers.items():
        if k.lower() == "access-control-allow-origin":
            return v
    return "none"


def pc_sign(href, collection):
    status, _, body = request(f"https://planetarycomputer.microsoft.com/api/sas/v1/token/{collection}")
    if status != 200:
        return href, f"token {status}"
    token = json.loads(body)["token"]
    return f"{href}?{token}", "token ok"


CASES = [
    ("Earth Search", "https://earth-search.aws.element84.com/v1/search", "sentinel-2-l2a", ["red"], "2025"),
    ("Earth Search", "https://earth-search.aws.element84.com/v1/search", "sentinel-2-c1-l2a", ["red"], "2025"),
    ("Earth Search", "https://earth-search.aws.element84.com/v1/search", "sentinel-2-l1c", ["red", "B04"], "2025"),
    ("Earth Search", "https://earth-search.aws.element84.com/v1/search", "landsat-c2-l2", ["red"], "2025"),
    ("Earth Search", "https://earth-search.aws.element84.com/v1/search", "sentinel-1-grd", ["vh"], "2025"),
    ("Planetary Computer", "https://planetarycomputer.microsoft.com/api/stac/v1/search", "sentinel-2-l2a", ["B04"], "2025"),
    ("Planetary Computer", "https://planetarycomputer.microsoft.com/api/stac/v1/search", "landsat-c2-l2", ["red"], "2025"),
    ("Planetary Computer", "https://planetarycomputer.microsoft.com/api/stac/v1/search", "landsat-c2-l1", ["red"], "2025"),
    ("Planetary Computer", "https://planetarycomputer.microsoft.com/api/stac/v1/search", "sentinel-1-rtc", ["vh"], "2025"),
    ("Planetary Computer", "https://planetarycomputer.microsoft.com/api/stac/v1/search", "sentinel-1-grd", ["vh"], "2025"),
    ("USGS LandsatLook", "https://landsatlook.usgs.gov/stac-server/search", "landsat-c2l2-sr", ["red"], "2023"),
    ("Copernicus Data Space", "https://stac.dataspace.copernicus.eu/v1/search", "sentinel-2-l2a", ["B04_10m", "B04"], "2025"),
    ("NASA CMR STAC", "https://cmr.earthdata.nasa.gov/stac/LPCLOUD/search", "HLSS30_2.0", ["B04"], "2025"),
]

for host, url, collection, keys, year in CASES:
    body = {"collections": [collection], "bbox": POINT, "datetime": f"{year}-08-01T00:00:00Z/{year}-09-01T00:00:00Z", "limit": 1}
    status, headers, raw = request(url, "POST", body)
    line = f"{host} | {collection} | search {status}, cors {acao(headers)}"
    try:
        features = json.loads(raw).get("features", [])
    except Exception:  # noqa: BLE001
        features = []
    if not features:
        print(line + " | no item returned")
        continue
    assets = features[0].get("assets", {})
    key = next((k for k in keys if k in assets), None)
    if key is None:
        print(line + f" | none of {keys} in assets {sorted(assets)[:12]}")
        continue
    asset = assets[key]
    href = asset["href"]
    alternates = asset.get("alternate", {})
    if not href.startswith("http"):
        https = next((a["href"] for a in alternates.values() if a.get("href", "").startswith("http")), None)
        if https is None:
            print(line + f" | asset {key} is {href[:60]}, no https alternate")
            continue
        href = https
    note = ""
    if host == "Planetary Computer":
        href, note = pc_sign(href, collection)
    s, h, b = request(href, headers={"Range": "bytes=0-1023"})
    snippet = b[:80].decode("latin-1").replace("\n", " ") if s != 206 else ""
    print(line + f" | asset {key} {href.split('?')[0][:70]} {note} | read {s}, cors {acao(h)} {snippet}")
