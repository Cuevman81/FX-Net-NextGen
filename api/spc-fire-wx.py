from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
import urllib.request
import io
import json
import re
import zipfile
import xml.etree.ElementTree as ET

# SPC Fire Weather Outlook is published as a "latest" KMZ for Days 1 and 2.
# (Days 3-8 are a single combined product with a different structure.)
FIREWX_KMZ = {
    '1': 'https://www.spc.noaa.gov/products/fire_wx/day1firewx.kmz',
    '2': 'https://www.spc.noaa.gov/products/fire_wx/day2firewx.kmz',
}

# The KMZ placemarks carry no inline style, so colors are assigned by name.
# Fill/stroke values sampled from SPC's own day1otlk_fire.png overlay:
#   Elevated  fill #FFBF80 / line #E08000
#   Critical  fill #FF8080 / line #FF0000
#   Extreme   fill #FF80FF / line #D000D0   (a.k.a. "Extremely Critical")
# Dry-thunderstorm areas are a separate overlay SPC draws as hatched outlines
# (no fill): Isolated = brown, Scattered = red. We mark them kind='dryt' so the
# frontend renders them as dashed boundaries over the categorical fills.
# Order matters: more specific names are matched first.
FIREWX_CATS = [
    ('scattered dry', {'label': 'Sct Dry Tstm', 'fill': None,      'stroke': '#FF0000', 'kind': 'dryt', 'rank': 5}),
    ('isolated dry',  {'label': 'Iso Dry Tstm', 'fill': None,      'stroke': '#8B4726', 'kind': 'dryt', 'rank': 4}),
    ('extreme',       {'label': 'Extreme',      'fill': '#FF80FF', 'stroke': '#D000D0', 'kind': 'cat',  'rank': 3}),
    ('critical',      {'label': 'Critical',     'fill': '#FF8080', 'stroke': '#FF0000', 'kind': 'cat',  'rank': 2}),
    ('elevated',      {'label': 'Elevated',     'fill': '#FFBF80', 'stroke': '#E08000', 'kind': 'cat',  'rank': 1}),
]


def _local(tag):
    return tag.split('}')[-1]


def _classify(name):
    n = (name or '').lower()
    for needle, meta in FIREWX_CATS:
        if needle in n:
            return meta
    return None


def _valid_from_kmlname(kml_name):
    # Inner KML is named like "260626_1700_day1firewx.kml" (YYMMDD_HHMM UTC).
    m = re.search(r'(\d{6})_(\d{4})', kml_name or '')
    if not m:
        return None
    d, t = m.group(1), m.group(2)
    return f'20{d[0:2]}-{d[2:4]}-{d[4:6]}T{t[0:2]}:{t[2:4]}:00Z'


def kmz_to_geojson(day):
    url = FIREWX_KMZ.get(str(day))
    if not url:
        raise ValueError('invalid day (1-2 only)')
    req = urllib.request.Request(url, headers={'User-Agent': 'FXNet-Proxy/1.0'})
    with urllib.request.urlopen(req, timeout=20) as r:
        raw = r.read()

    zf = zipfile.ZipFile(io.BytesIO(raw))
    kml_name = next((n for n in zf.namelist() if n.lower().endswith('.kml')), 'doc.kml')
    kml_bytes = zf.read(kml_name)

    # Defense-in-depth against XXE / billion-laughs: SPC KML carries no DTD, so
    # reject any document that declares one rather than parsing it.
    head = kml_bytes[:4096].lower()
    if b'<!doctype' in head or b'<!entity' in head:
        raise ValueError('KML contains a DTD/entity declaration; refusing to parse')
    root = ET.fromstring(kml_bytes)

    valid = _valid_from_kmlname(kml_name)
    features = []
    for pm in root.iter():
        if _local(pm.tag) != 'Placemark':
            continue
        name = None
        for ch in pm:
            if _local(ch.tag) == 'name':
                name = (ch.text or '').strip()
        meta = _classify(name)
        if not meta:
            continue

        # One Feature per <Polygon> (handles MultiGeometry); exterior ring first,
        # then any holes (KML lists outerBoundaryIs before innerBoundaryIs).
        for poly in pm.iter():
            if _local(poly.tag) != 'Polygon':
                continue
            rings = []
            for boundary in poly:
                if _local(boundary.tag) in ('outerBoundaryIs', 'innerBoundaryIs'):
                    for node in boundary.iter():
                        if _local(node.tag) == 'coordinates' and node.text:
                            coords = []
                            for tok in node.text.split():
                                parts = tok.split(',')
                                if len(parts) >= 2:
                                    coords.append([float(parts[0]), float(parts[1])])
                            if len(coords) >= 4:
                                rings.append(coords)
            if rings:
                features.append({
                    'type': 'Feature',
                    'properties': {
                        'category': name,
                        'label': meta['label'],
                        'fill': meta['fill'],
                        'stroke': meta['stroke'],
                        'kind': meta['kind'],
                        'rank': meta['rank'],
                    },
                    'geometry': {'type': 'Polygon', 'coordinates': rings},
                })

    return {'type': 'FeatureCollection', 'valid': valid, 'features': features}


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            qs = parse_qs(urlparse(self.path).query)
            day = (qs.get('day', ['1'])[0])
            if day not in FIREWX_KMZ:
                day = '1'
            geojson = kmz_to_geojson(day)
            body = json.dumps(geojson).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:
            self.send_response(500)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({'error': str(e)}).encode())
