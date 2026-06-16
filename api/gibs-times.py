"""
Return the most recent available timestamps for a NASA GIBS layer, so the
satellite loop steps through *real* frames (GIBS has gaps — naive 10-min
stepping would hit missing frames and flash transparent).

GIBS DescribeDomains lists the full time domain (back to 2021, ~1 MB and
growing) with no Range support, so we fetch it server-side and return just
the last N timestamps as a tiny JSON list. The live frame doesn't need this
(it uses the GIBS 'default' time keyword); only the loop does.

GET /api/gibs-times?layer=GOES-East_ABI_GeoColor&tms=GoogleMapsCompatible_Level7&n=30
  -> { "times": ["2026-06-16T14:20:00Z", ...] }   (oldest -> newest)
"""
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
import urllib.request
import datetime
import json
import re

GIBS = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/1.0.0'
_LAYER_RE = re.compile(r'^[A-Za-z0-9_\-]+$')   # guard against path injection


def recent_times(layer, tms, n):
    if not _LAYER_RE.match(layer) or not _LAYER_RE.match(tms):
        raise ValueError('bad layer/tms')
    url = f'{GIBS}/{layer}/default/{tms}/all/all.xml'
    req = urllib.request.Request(url, headers={'User-Agent': 'FXNet-Proxy/1.0'})
    with urllib.request.urlopen(req, timeout=20) as r:
        xml = r.read().decode('utf-8', 'replace')
    m = re.search(r'<Domain>([^<]+)</Domain>', xml)
    if not m:
        return []
    # Only expand the tail segments (each is start/end/PT#M); newest are last.
    segs = m.group(1).split(',')
    times = []
    for seg in segs[-12:]:
        parts = seg.split('/')
        if len(parts) != 3:
            continue
        try:
            start = datetime.datetime.fromisoformat(parts[0].replace('Z', '+00:00'))
            end = datetime.datetime.fromisoformat(parts[1].replace('Z', '+00:00'))
        except ValueError:
            continue
        step = int(re.sub(r'\D', '', parts[2]) or '10')
        step = step if step > 0 else 10
        t = start
        guard = 0
        while t <= end and guard < 5000:
            times.append(t.strftime('%Y-%m-%dT%H:%M:%SZ'))
            t += datetime.timedelta(minutes=step)
            guard += 1
    return times[-n:]


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            qs = parse_qs(urlparse(self.path).query)
            layer = qs.get('layer', ['GOES-East_ABI_GeoColor'])[0]
            tms = qs.get('tms', ['GoogleMapsCompatible_Level7'])[0]
            n = max(1, min(int(qs.get('n', ['30'])[0]), 60))
            body = json.dumps({'times': recent_times(layer, tms, n)}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Cache-Control', 'public, max-age=120')
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:
            self.send_response(500)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({'error': str(e), 'times': []}).encode())
