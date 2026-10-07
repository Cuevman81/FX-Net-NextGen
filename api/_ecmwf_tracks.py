"""ECMWF tropical cyclone tracks from ECMWF open data, served as ATCF a-deck text.

Three products, all free under CC BY 4.0 (attribution: "(c) ECMWF"):
    aifs      AIFS Single, ECMWF's deterministic AI model
    aifs-ens  AIFS ENS, the 51-member AI ensemble (50 perturbed + control)
    ifs-ens   the IFS physics ensemble (50 perturbed + control)

NHC's public a-deck carries none of them. ECMWF publishes each run's tracks as
one BUFR file (WMO template 3 16 082, "tropical cyclone track and wind radii"),
one message per storm, ensemble members as subsets, usually compressed.

A general BUFR library (pybufrkit) decodes a whole ensemble file in ~25 s,
too slow for a request, and the dev server runs on a bare system Python. This
module decodes the one template it needs with the standard library instead: it
reads each message's header, skips every storm but the one asked for, and
decodes that storm in well under a second. It matched pybufrkit on every value
of 2,882 tracks in three full files; tests/test_ecmwf_tracks.py pins real
fixtures cut from them.

GET /api/ecmwf-tracks?model=aifs-ens&id=al092026
    -> '# ecmwf aifs-ens run=2026100700 storm=09L members=51' + a-deck rows
       (empty body after the comment when ECMWF is not tracking the storm)
"""
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
import datetime
import re
import threading
import time
import urllib.error
import urllib.request

BASE = 'https://data.ecmwf.int/forecasts'
UA = {'User-Agent': 'FXNet-Proxy/1.0'}

# model -> (path under the run, file type, forecast lengths to try, ATCF tech prefix)
MODELS = {
    'aifs':     ('aifs-single/0p25/oper', 'oper', ('360h',), None),
    'aifs-ens': ('aifs-ens/0p25/enfo', 'enfo', ('360h',), 'AF'),
    'ifs-ens':  ('ifs/0p25/enfo', 'enfo', ('360h', '144h'), 'XE'),
}

_ID_RE = re.compile(r'^(al|ep|cp)(\d{2})(\d{4})$')
_BASIN_LETTER = {'al': 'L', 'ep': 'E', 'cp': 'C'}

# ─── BUFR template 3 16 082 ───
# (descriptor, bits, scale, reference, is_text). Widths and scales are WMO
# Table B (master table 35); 019004 carries the template's own 201131 operator
# (+3 bits). 001030 precedes the template in ECMWF's section 3.
_E = {
    1030: (128, 0, 0, True), 1033: (8, 0, 0, False), 1034: (8, 0, 0, False),
    1032: (8, 0, 0, False), 1025: (24, 0, 0, True), 1027: (80, 0, 0, True),
    1090: (8, 0, 0, False), 1091: (10, 0, 0, False), 1092: (8, 0, 0, False),
    4001: (12, 0, 0, False), 4002: (4, 0, 0, False), 4003: (6, 0, 0, False),
    4004: (5, 0, 0, False), 4005: (6, 0, 0, False),
    8005: (4, 0, 0, False), 5002: (15, 2, -9000, False), 6002: (16, 2, -18000, False),
    10051: (14, -1, 0, False), 11012: (12, 1, 0, False),
    19003: (8, 0, 0, False), 5021: (16, 2, 0, False), 19004: (15, -2, 0, False),
    8021: (5, 0, 0, False), 4024: (12, 0, -2048, False), 31001: (8, 0, 0, False),
}
# 001030 (model name) precedes the template in the AIFS files only; the IFS
# ensemble file starts straight at 3 16 082. Section 3 says which.
_HEADER = [1033, 1034, 1032, 1025, 1027, 1090, 1091, 1092, 4001, 4002, 4003, 4004, 4005]
_RADII = ([19003] + [5021, 5021, 19004] * 4) * 3
_INITIAL = [8005, 5002, 6002, 8005, 5002, 6002, 10051, 8005, 5002, 6002, 11012] + _RADII
_STEP = [8021, 4024, 8005, 5002, 6002, 10051, 8005, 5002, 6002, 11012] + _RADII


class _Bits:
    __slots__ = ('b', 'pos')

    def __init__(self, data):
        self.b = data
        self.pos = 0

    def read(self, n):
        if n == 0:
            return 0
        start = self.pos >> 3
        end = (self.pos + n + 7) >> 3
        chunk = int.from_bytes(self.b[start:end], 'big')
        shift = (end - start) * 8 - ((self.pos & 7) + n)
        self.pos += n
        return (chunk >> shift) & ((1 << n) - 1)


def _num(raw, bits, scale, ref):
    if raw == (1 << bits) - 1:
        return None                      # all ones = missing
    v = raw + ref
    return v / (10 ** scale) if scale else v


def _text(raw, bits):
    s = raw.to_bytes(bits // 8, 'big')
    if s == b'\xff' * (bits // 8):
        return None
    return s.decode('latin-1').replace('\x00', '').strip()


class _Message:
    """One BUFR message: section offsets, subset count, compression."""

    def __init__(self, raw):
        if raw[:4] != b'BUFR' or raw[7] != 4:
            raise ValueError('not a BUFR edition 4 message')
        p = 8
        s1 = int.from_bytes(raw[p:p + 3], 'big')
        has_s2 = raw[p + 9] & 0x80
        p += s1
        if has_s2:
            p += int.from_bytes(raw[p:p + 3], 'big')
        s3 = int.from_bytes(raw[p:p + 3], 'big')
        self.n_subsets = int.from_bytes(raw[p + 4:p + 6], 'big')
        self.compressed = bool(raw[p + 6] & 0x40)
        descs = []
        for q in range(p + 7, p + s3 - 1, 2):
            f = raw[q] >> 6
            descs.append(f * 100000 + (raw[q] & 0x3F) * 1000 + raw[q + 1])
        if 316082 not in descs:
            raise ValueError(f'unexpected BUFR template {descs}')
        self.header = ([1030] if 1030 in descs else []) + _HEADER
        p += s3
        s4 = int.from_bytes(raw[p:p + 3], 'big')
        self.data = raw[p + 4:p + s4]


def split_messages(blob):
    out, i = [], 0
    while True:
        j = blob.find(b'BUFR', i)
        if j < 0 or j + 8 > len(blob):
            return out
        n = int.from_bytes(blob[j + 4:j + 7], 'big')
        if n < 8:
            return out
        out.append(blob[j:j + n])
        i = j + n


def _read_uncompressed(bits, desc):
    w, sc, ref, txt = _E[desc]
    raw = bits.read(w)
    return _text(raw, w) if txt else _num(raw, w, sc, ref)


def _read_compressed(bits, desc, n):
    """Values of one descriptor for all n subsets (compressed layout)."""
    w, sc, ref, txt = _E[desc]
    r0 = bits.read(w)
    nb = bits.read(6)
    if txt:
        if nb == 0:
            v = _text(r0, w)
            return [v] * n
        return [_text(bits.read(nb * 8), nb * 8) for _ in range(n)]
    if nb == 0:
        v = _num(r0, w, sc, ref)
        return [v] * n
    if r0 == (1 << w) - 1:
        # Base missing: every subset is missing, increments carry nothing useful
        bits.read(nb * n)
        return [None] * n
    out = []
    for _ in range(n):
        inc = bits.read(nb)
        out.append(None if inc == (1 << nb) - 1 else _num(r0 + inc, w + 64, sc, ref))
    return out


def _subset_track(header, initial, steps):
    """Fold the template's flat values into one track: [(tau, lat, lon, mslp_hpa, wind_ms)]."""
    if len(header) == len(_HEADER):
        header = [None] + header          # no 001030 in this file
    pts = []
    # Initial block: sig1 (observed) lat lon, sig5 (analysed) lat lon mslp, sig3 lat lon wind
    _, olat, olon, _, alat, alon, amslp, _, _, _, awind = initial[:11]
    lat, lon = (alat, alon) if alat is not None and alon is not None else (olat, olon)
    if lat is not None and lon is not None:
        pts.append((0, lat, lon, amslp / 100 if amslp else None, awind))
    for s in steps:
        _, tau, _, slat, slon, smslp, _, _, _, swind = s[:10]
        if tau is None or slat is None or slon is None:
            continue
        pts.append((int(tau), slat, slon, smslp / 100 if smslp else None, swind))
    return {
        'model': header[0], 'storm': header[4], 'name': header[5], 'member': header[7],
        'dtg': '%04d%02d%02d%02d' % (header[9], header[10], header[11], header[12]),
        'points': pts,
    }


def decode_message(raw, want_storm=None):
    """Decode one message into tracks (one per subset). With want_storm, stop
    after the header and return None when this message is another storm."""
    m = _Message(raw)
    bits = _Bits(m.data)
    n = m.n_subsets
    if m.compressed:
        header = [_read_compressed(bits, d, n) for d in m.header]
        sid = header[m.header.index(1025)][0]
        if want_storm is not None and (sid or '') != want_storm:
            return None
        initial = [_read_compressed(bits, d, n) for d in _INITIAL]
        reps = _read_compressed(bits, 31001, n)[0] or 0
        steps = [[_read_compressed(bits, d, n) for d in _STEP] for _ in range(int(reps))]
        tracks = []
        for k in range(n):
            tracks.append(_subset_track([h[k] for h in header], [v[k] for v in initial],
                                        [[v[k] for v in st] for st in steps]))
        return tracks
    tracks = []
    for k in range(n):
        header = [_read_uncompressed(bits, d) for d in m.header]
        if want_storm is not None and k == 0 and (header[m.header.index(1025)] or '') != want_storm:
            return None
        initial = [_read_uncompressed(bits, d) for d in _INITIAL]
        reps = _read_uncompressed(bits, 31001) or 0
        steps = [[_read_uncompressed(bits, d) for d in _STEP] for _ in range(int(reps))]
        tracks.append(_subset_track(header, initial, steps))
    return tracks


def storm_tracks(blob, storm):
    """All tracks for one ECMWF storm id (e.g. '09L') in a track file."""
    out = []
    for raw in split_messages(blob):
        try:
            got = decode_message(raw, storm)
        except Exception:
            continue                      # one bad message must not sink the storm
        if got:
            out.extend(got)
    return out


# ─── ATCF output ───
def _ll(v, pos, neg):
    return '%d%s' % (round(abs(v) * 10), pos if v >= 0 else neg)


def _row(basin, num, dtg, tech, p):
    tau, lat, lon, mslp, wind = p
    vmax = '%d' % round(wind * 1.943844) if wind is not None else '0'
    pres = '%d' % round(mslp) if mslp is not None else '0'
    return f'{basin.upper()}, {num}, {dtg}, 03, {tech}, {tau}, {_ll(lat, "N", "S")}, {_ll(lon, "E", "W")}, {vmax}, {pres}'


def ensemble_mean(tracks):
    """Mean position (and intensity) at each forecast hour, kept only while at
    least half the members still have the storm — past that, a mean of the
    few survivors is not the ensemble's answer."""
    by_tau = {}
    for t in tracks:
        for p in t['points']:
            by_tau.setdefault(p[0], []).append(p)
    need = max(2, (len(tracks) + 1) // 2)
    out = []
    for tau in sorted(by_tau):
        ps = by_tau[tau]
        if len(ps) < need:
            break
        ref = ps[0][2]
        lons = [l if abs(l - ref) <= 180 else (l - 360 if l > ref else l + 360) for _, _, l, _, _ in ps]
        lon = sum(lons) / len(lons)
        lon = (lon + 180) % 360 - 180
        pr = [p[3] for p in ps if p[3] is not None]
        wd = [p[4] for p in ps if p[4] is not None]
        out.append((tau, sum(p[1] for p in ps) / len(ps), lon,
                    sum(pr) / len(pr) if pr else None, sum(wd) / len(wd) if wd else None))
    return out


def to_adeck(model, atcf_id, tracks):
    basin, num = atcf_id[:2], atcf_id[2:4]
    lines = []
    prefix = MODELS[model][3]
    members = []
    for t in tracks:
        if len(t['points']) < 2:
            continue
        if prefix is None:
            tech = 'AIFS'
        else:
            # ECMWF numbering: 1-50 perturbed, 51 the control, 52 the
            # deterministic run carried along (AIFS Single / IFS HRES — both
            # shown elsewhere, so skipped here).
            mem = t['member']
            if mem is None or mem > 51 or mem < 1:
                continue
            tech = f'{prefix}{0 if mem == 51 else int(mem):02d}'
            members.append(t)
        lines.extend(_row(basin, num, t['dtg'], tech, p) for p in t['points'])
    if prefix and len(members) >= 4:
        mean = ensemble_mean(members)
        if len(mean) >= 2:
            dtg = members[0]['dtg']
            lines.extend(_row(basin, num, dtg, f'{prefix}MN', p) for p in mean)
    return lines, len(members)


# ─── Run discovery + cache ───
_cache = {}            # url -> (fetched_at, bytes or None)
_lock = threading.Lock()
_TTL_HIT, _TTL_MISS = 3 * 3600, 600


def _get(url, head=False):
    with _lock:
        hit = _cache.get(url)
    if hit and time.time() - hit[0] < (_TTL_HIT if hit[1] else _TTL_MISS):
        return hit[1]
    req = urllib.request.Request(url, headers=UA, method='HEAD' if head else 'GET')
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            body = b'' if head else r.read()
    except urllib.error.HTTPError as e:
        if e.code != 404:
            raise
        body = None
    if not head or body is None:
        with _lock:
            _cache[url] = (time.time(), body)
    return body


def _candidate_urls(model, now):
    path, kind, steps, _ = MODELS[model]
    t = now.replace(minute=0, second=0, microsecond=0)
    t -= datetime.timedelta(hours=t.hour % 6)
    for _ in range(6):                    # newest synoptic time back 30 h
        d = t.strftime('%Y%m%d')
        for step in steps:
            yield t.strftime('%Y%m%d%H'), f'{BASE}/{d}/{t:%H}z/{path}/{t:%Y%m%d%H}0000-{step}-{kind}-tf.bufr'
        t -= datetime.timedelta(hours=6)


def fetch(model, atcf_id, now=None):
    """a-deck text for one storm from the newest run that tracks it."""
    if model not in MODELS:
        raise ValueError('unknown model')
    m = _ID_RE.match((atcf_id or '').lower())
    if not m:
        raise ValueError('bad storm id')
    storm = f'{m.group(2)}{_BASIN_LETTER[m.group(1)]}'
    now = now or datetime.datetime.now(datetime.timezone.utc)
    published = 0
    for run, url in _candidate_urls(model, now):
        blob = _get(url)
        if blob is None:
            continue                      # not published (yet)
        published += 1
        tracks = storm_tracks(blob, storm)
        lines, n = to_adeck(model, atcf_id.lower(), tracks)
        if lines:
            return '\n'.join([f'# ecmwf {model} run={run} storm={storm} members={n}'] + lines) + '\n'
        if published >= 2:
            break                         # two runs without it: ECMWF isn't tracking this storm
    return f'# ecmwf {model} storm={storm} none\n'


class handler(BaseHTTPRequestHandler):
    def do_HEAD(self):
        self.send_response(200)
        self.send_header('Content-Type', 'text/plain')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()

    def do_GET(self):
        try:
            qs = parse_qs(urlparse(self.path).query)
            body = fetch(qs.get('model', [''])[0], qs.get('id', [''])[0]).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'text/plain; charset=utf-8')
            self.send_header('Access-Control-Allow-Origin', '*')
            # A run lands every 6 h; the edge can share one decode for 15 min.
            self.send_header('Cache-Control', 'public, max-age=300, s-maxage=900, stale-while-revalidate=1800')
            self.end_headers()
            self.wfile.write(body)
        except ValueError as e:
            self.send_response(400)
            self.send_header('Content-Type', 'text/plain')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(f'ERROR: {e}'.encode())
        except Exception as e:
            self.send_response(502)
            self.send_header('Content-Type', 'text/plain')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(f'ERROR: ECMWF open data unavailable ({e})'.encode())
