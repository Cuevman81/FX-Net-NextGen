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
from concurrent.futures import ThreadPoolExecutor
import urllib.request
import datetime
import json
import re
import traceback

GIBS = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/1.0.0'
GIBS_TILES = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best'
_LAYER_RE = re.compile(r'^[A-Za-z0-9_\-]+$')   # guard against path injection
# Allow-list of the GIBS layers the client actually requests (app.js GIBS_PRODUCTS),
# and the tile-matrix sets those layers publish. Anything else is refused before
# a URL is built, so the function can never be pointed at an arbitrary GIBS path.
_KNOWN_LAYERS = frozenset(
    f'GOES-{bird}_ABI_{suffix}'
    for bird in ('East', 'West')
    for suffix in ('GeoColor', 'Band13_Clean_Infrared', 'Band2_Red_Visible_1km',
                   'Air_Mass', 'Dust', 'FireTemp'))
_TMS_RE = re.compile(r'^GoogleMapsCompatible_Level[0-9]$')

# GIBS lists a timestamp in its time domain as soon as a scan is scheduled, but
# the actual tiles are frequently NOT published — both at the leading edge (the
# newest 1-2 frames lag) and as interior gaps (whole missing scans). This is
# worst for the slow-cadence visible bands, e.g. Band 2 Red Visible, where it
# leaves the live view and the loop flashing empty frames. An unpublished frame
# returns a tiny ~700 B-1 KB blank PNG, so we probe a single low-zoom tile
# (z2/1/1 spans the whole GOES-East disk) for each candidate frame and keep only
# the ones that actually have imagery. Probes run in parallel to stay fast.
_BLANK_BYTES = 5000    # published GOES tiles are 40-60 KB; blanks are <1.5 KB
_PROBE_WINDOW = 48     # probe at most this many newest candidate frames
_PROBE_WORKERS = 16


def _tile_bytes(layer, tms, iso):
    """Content-Length of the z2/1/1 probe tile for one frame, or None on error."""
    url = f'{GIBS_TILES}/{layer}/default/{iso}/{tms}/2/1/1.png'
    req = urllib.request.Request(url, method='HEAD',
                                 headers={'User-Agent': 'FXNet-Proxy/1.0'})
    try:
        with urllib.request.urlopen(req, timeout=6) as r:
            cl = r.headers.get('Content-Length')
            return int(cl) if cl is not None else None
    except Exception:
        return None


def _keep_published(times, layer, tms):
    """Filter the candidate frames down to the ones whose tiles are published.

    Probes z2/1/1 for each candidate in parallel and drops blanks (anywhere in
    the series, not just the tail). Fails open: a frame whose probe errors out
    (None) is kept, so a transient GIBS hiccup never empties the list. If the
    probe tile turns out blank for *every* frame (unexpected for a layer), we
    assume it's unreliable and return the input unfiltered.
    """
    if len(times) <= 1:
        return times
    cand = times[-_PROBE_WINDOW:]
    with ThreadPoolExecutor(max_workers=_PROBE_WORKERS) as ex:
        sizes = list(ex.map(lambda t: _tile_bytes(layer, tms, t), cand))
    kept = [t for t, sz in zip(cand, sizes) if sz is None or sz >= _BLANK_BYTES]
    return kept if kept else times


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
    times = _keep_published(times, layer, tms)
    return times[-n:]


class handler(BaseHTTPRequestHandler):
    def do_HEAD(self):
        # Uptime monitors probe with HEAD by default. Answer with headers only —
        # no upstream fetch — so a monitor sees 200 instead of the 501 that
        # BaseHTTPRequestHandler returns for an unimplemented method.
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()

    def do_GET(self):
        try:
            qs = parse_qs(urlparse(self.path).query)
            layer = qs.get('layer', ['GOES-East_ABI_GeoColor'])[0]
            tms = qs.get('tms', ['GoogleMapsCompatible_Level7'])[0]
            if layer not in _KNOWN_LAYERS or not _TMS_RE.match(tms):
                raise ValueError('unknown layer or tile matrix set')
            n = max(1, min(int(qs.get('n', ['30'])[0]), 60))
            body = json.dumps({'times': recent_times(layer, tms, n)}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Cache-Control', 'public, max-age=120')
            self.end_headers()
            self.wfile.write(body)
        except ValueError as e:
            # Deliberate validation / not-yet-published messages: safe to return.
            self.send_response(400)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({'error': str(e), 'times': []}).encode())
        except Exception:
            # Upstream/network failures can carry internal URLs and paths —
            # log server-side, tell the client only that the fetch failed.
            traceback.print_exc()
            self.send_response(502)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({'error': 'upstream fetch failed', 'times': []}).encode())
