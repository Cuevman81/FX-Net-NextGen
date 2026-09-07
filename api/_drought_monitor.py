from http.server import BaseHTTPRequestHandler
import urllib.request
import urllib.error
import datetime
import json
import traceback

# USDM publishes ~14 decimal places of coordinate precision — roughly a
# nanometre — across ~268k points, which is why the raw file is 28 MB. The
# map draws these polygons at national to state zoom, so 4 decimal places
# (~11 m) is far more resolution than any pixel can show. Rounding there and
# dropping the three properties the frontend never reads takes the response
# to about 5 MB with no visible change.
_PRECISION = 4

# Only DM (drought category 0-4) is read by the client; OBJECTID,
# Shape_Length and Shape_Area are dead weight.
_KEEP = 'DM'


def _slim(coords, nd=_PRECISION):
    """Round every coordinate and drop points that rounding made duplicates.

    Rings are kept closed and never collapsed below 4 points, so a polygon
    that rounds down to a sliver is left at full precision rather than being
    turned into invalid geometry.
    """
    if isinstance(coords, list) and coords and isinstance(coords[0], (int, float)):
        return [round(coords[0], nd), round(coords[1], nd)]

    out = [_slim(c, nd) for c in coords]

    is_ring = out and isinstance(out[0], list) and out[0] and isinstance(out[0][0], (int, float))
    if is_ring:
        deduped = [out[0]]
        for point in out[1:]:
            if point != deduped[-1]:
                deduped.append(point)
        if len(deduped) >= 4:
            if deduped[0] != deduped[-1]:
                deduped.append(deduped[0])
            return deduped
    return out


def slim_usdm(raw):
    """28 MB of raw USDM GeoJSON -> ~5 MB carrying the same drawn shape."""
    source = json.loads(raw)
    features = []
    for feature in source.get('features', []):
        geometry = feature.get('geometry') or {}
        if not geometry.get('coordinates'):
            continue
        features.append({
            'type': 'Feature',
            'properties': {_KEEP: (feature.get('properties') or {}).get(_KEEP)},
            'geometry': {
                'type': geometry.get('type'),
                'coordinates': _slim(geometry['coordinates']),
            },
        })
    return json.dumps(
        {'type': 'FeatureCollection', 'features': features},
        separators=(',', ':'),
    ).encode()


def _fetch_usdm():
    """Newest published USDM week, falling back one week if today's Tuesday
    file is not up yet."""
    today = datetime.date.today()
    tuesday = today - datetime.timedelta(days=(today.weekday() - 1) % 7)

    def get(day):
        url = f'https://droughtmonitor.unl.edu/data/json/usdm_{day.strftime("%Y%m%d")}.json'
        req = urllib.request.Request(url, headers={'User-Agent': 'FXNet-VercelProxy/1.0'})
        with urllib.request.urlopen(req, timeout=25) as response:
            return response.read()

    try:
        return get(tuesday)
    except urllib.error.HTTPError as err:
        if err.code != 404:
            raise
        return get(tuesday - datetime.timedelta(days=7))


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
            body = slim_usdm(_fetch_usdm())

            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            # USDM updates weekly (Thursdays); cache aggressively.
            self.send_header('Cache-Control', 'public, max-age=3600, s-maxage=21600')
            self.end_headers()
            self.wfile.write(body)
        except ValueError as e:
            # Deliberate validation / not-yet-published messages: safe to return.
            self.send_response(400)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({'error': str(e)}).encode())
        except Exception:
            # Upstream/network failures can carry internal URLs and paths —
            # log server-side, tell the client only that the fetch failed.
            traceback.print_exc()
            self.send_response(502)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({'error': 'upstream fetch failed'}).encode())
