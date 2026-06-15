from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
import urllib.request
import io
import json
import zipfile
import xml.etree.ElementTree as ET

# WPC Excessive Rainfall Outlook is published as KMZ for Days 1-3 only.
ERO_KMZ = {
    '1': 'https://www.wpc.ncep.noaa.gov/kml/ero/Day_1_Excessive_Rainfall_Outlook.kmz',
    '2': 'https://www.wpc.ncep.noaa.gov/kml/ero/Day_2_Excessive_Rainfall_Outlook.kmz',
    '3': 'https://www.wpc.ncep.noaa.gov/kml/ero/Day_3_Excessive_Rainfall_Outlook.kmz',
}

# Standard WPC ERO category colors (fallback if a KML style color is missing).
ERO_COLORS = {
    'marginal': '#66c267',
    'slight':   '#f6e94b',
    'moderate': '#e06666',
    'high':     '#cc66cc',
}


def _local(tag):
    return tag.split('}')[-1]


def _abgr_to_hex(kml_color):
    # KML colors are AABBGGRR; convert to #RRGGBB.
    try:
        c = kml_color.strip()
        return '#' + c[6:8] + c[4:6] + c[2:4]
    except Exception:
        return None


def kmz_to_geojson(day):
    url = ERO_KMZ.get(str(day))
    if not url:
        raise ValueError('invalid day (1-3 only)')
    req = urllib.request.Request(url, headers={'User-Agent': 'FXNet-Proxy/1.0'})
    with urllib.request.urlopen(req, timeout=20) as r:
        raw = r.read()

    zf = zipfile.ZipFile(io.BytesIO(raw))
    kml_name = next((n for n in zf.namelist() if n.lower().endswith('.kml')), 'doc.kml')
    kml_bytes = zf.read(kml_name)

    # Defense-in-depth: stdlib ElementTree can be abused via DTD/entity expansion
    # (XXE / billion-laughs). WPC KML has no DOCTYPE, so reject any document that
    # declares one rather than pulling in a non-stdlib parser.
    head = kml_bytes[:4096].lower()
    if b'<!doctype' in head or b'<!entity' in head:
        raise ValueError('KML contains a DTD/entity declaration; refusing to parse')
    root = ET.fromstring(kml_bytes)

    # styleId -> fill hex (from each Style's PolyStyle color)
    styles = {}
    for st in root.iter():
        if _local(st.tag) == 'Style' and st.get('id'):
            for poly in st.iter():
                if _local(poly.tag) == 'PolyStyle':
                    for c in poly.iter():
                        if _local(c.tag) == 'color' and c.text:
                            styles[st.get('id')] = _abgr_to_hex(c.text)

    features = []
    for pm in root.iter():
        if _local(pm.tag) != 'Placemark':
            continue
        name = None
        style_id = None
        for ch in pm:
            ln = _local(ch.tag)
            if ln == 'name':
                name = (ch.text or '').strip()
            elif ln == 'styleUrl':
                style_id = (ch.text or '').lstrip('#').strip()
        if not name:
            continue

        lname = name.lower()
        cat = next((k for k in ERO_COLORS if k in lname), None)
        fill = styles.get(style_id) or (ERO_COLORS.get(cat) if cat else '#888888')

        for poly in pm.iter():
            if _local(poly.tag) != 'Polygon':
                continue
            rings = []  # exterior first (KML lists outerBoundaryIs before innerBoundaryIs)
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
                    'properties': {'category': name, 'fill': fill, 'stroke': fill},
                    'geometry': {'type': 'Polygon', 'coordinates': rings},
                })

    return {'type': 'FeatureCollection', 'features': features}


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            qs = parse_qs(urlparse(self.path).query)
            day = (qs.get('day', ['1'])[0])
            if day not in ERO_KMZ:
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
