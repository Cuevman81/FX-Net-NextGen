from http.server import BaseHTTPRequestHandler
import urllib.request
import json
import re

# NOAA/NCEP mirror of the CIMSS ProbSevere model. New GeoJSON is published to this
# directory every ~2 minutes; there is no "latest" alias, so we scrape the listing
# and pick the newest MRMS_PROBSEVERE_YYYYMMDD_HHMMSS.json file.
LISTING_URL = 'https://mrms.ncep.noaa.gov/data/ProbSevere/PROBSEVERE/'
FILE_RE = re.compile(r'MRMS_PROBSEVERE_\d{8}_\d{6}\.json')

# Curated property set — the full record carries ~50 fields per storm; we keep the
# operationally meaningful ones so the payload stays light on the wire.
KEEP = [
    'ID', 'ProbSevere', 'ProbTor', 'ProbWind', 'ProbHail',
    'MUCAPE', 'MLCAPE', 'MLCIN', 'EBSHEAR', 'SRH01KM',
    'MESH', 'VIL', 'COMPREF', 'MOTION_EAST', 'MOTION_SOUTH',
    'PWAT', 'DCAPE', 'LLLR', 'MEANWIND_1-3kmAGL',
]


def _fetch(url, timeout=15):
    req = urllib.request.Request(url, headers={'User-Agent': 'FXNet-Proxy/1.0'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def latest_probsevere():
    listing = _fetch(LISTING_URL, timeout=15).decode('utf-8', 'replace')
    names = FILE_RE.findall(listing)
    if not names:
        raise ValueError('no ProbSevere files found in listing')
    newest = sorted(set(names))[-1]
    raw = _fetch(LISTING_URL + newest, timeout=15)
    data = json.loads(raw)

    features = []
    for f in data.get('features', []):
        props = f.get('properties', {}) or {}
        slim = {k: props[k] for k in KEEP if k in props}
        features.append({
            'type': 'Feature',
            'geometry': f.get('geometry'),
            'properties': slim,
        })

    return {
        'type': 'FeatureCollection',
        'validTime': data.get('validTime'),
        'file': newest,
        'features': features,
    }


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            geojson = latest_probsevere()
            body = json.dumps(geojson).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            # New model runs every ~2 min; browser revalidates after 60s, CDN shields
            # the NCEP host for 90s so rapid polling never stampedes upstream.
            self.send_header('Cache-Control', 'public, max-age=60, s-maxage=90')
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:
            self.send_response(502)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({'error': str(e)}).encode())
