from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs, quote
import urllib.request
import json
import re

# Upper-air sounding proxy. Primary source is the University of Wyoming's
# high-resolution BUFR listing (~1-2 s radiosonde data, thousands of levels),
# which needs a WMO station number and is not CORS-open. We fall back to the
# IEM decoded RAOB (mandatory + significant levels, ~50-250 levels) which takes
# the ICAO id directly. Both are normalized to the same profile schema.
WYO_URL = 'https://weather.uwyo.edu/wsgi/sounding?datetime={dt}&id={wmo}&type=TEXT:LIST&src=UNKNOWN'
IEM_URL = 'https://mesonet.agron.iastate.edu/json/raob.py?ts={ts}&station={station}'
_ROW = re.compile(r'^\s*-?\d')
# Guard station/WMO before they reach an upstream URL — the host is fixed (no
# SSRF), but this stops stray characters smuggling extra query params.
_STATION_RE = re.compile(r'^[A-Z0-9]{3,5}$')
_WMO_RE = re.compile(r'^\d{4,6}$')


def _fetch(url, timeout=22):
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (FXNet-Proxy)'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode('utf-8', 'replace')


def _num(s):
    s = s.strip()
    if s in ('', '-', '----', '/////'):
        return None
    try:
        return float(s)
    except ValueError:
        return None


def parse_wyoming(text):
    m = re.search(r'<PRE>(.*?)</PRE>', text, re.S)
    if not m:
        return None
    prof = []
    for ln in m.group(1).splitlines():
        if not _ROW.match(ln):
            continue
        # Fixed-width 7-char columns: PRES HGHT TEMP DWPT RELH MIXR DRCT SPED ...
        pres = _num(ln[0:7]); hght = _num(ln[7:14]); tmpc = _num(ln[14:21])
        dwpc = _num(ln[21:28]); drct = _num(ln[42:49]); sped = _num(ln[49:56])
        if pres is None or tmpc is None:
            continue
        prof.append({
            'pres': pres, 'hght': hght, 'tmpc': tmpc, 'dwpc': dwpc,
            'drct': drct, 'sknt': (sped * 1.94384 if sped is not None else None),
        })
    return prof if len(prof) > 10 else None


def get_raob(wmo, station, ts):
    # Wyoming wants "YYYY-MM-DD HH:MM:SS"; IEM keeps the ISO "...T..Z".
    dt = ts.replace('T', ' ').replace('Z', '')
    if wmo and _WMO_RE.match(wmo):
        try:
            raw = _fetch(WYO_URL.format(dt=quote(dt), wmo=quote(wmo)))
            prof = parse_wyoming(raw)
            if prof:
                return {'success': True, 'source': 'wyoming', 'station': station,
                        'valid': dt + 'Z', 'profile': prof}
        except Exception:
            pass  # fall through to IEM
    if not _STATION_RE.match(station):
        return {'success': False, 'error': 'invalid station', 'profile': []}
    raw = _fetch(IEM_URL.format(ts=quote(ts), station=quote(station)))
    j = json.loads(raw)
    profs = j.get('profiles') or []
    if profs and profs[0].get('profile'):
        p0 = profs[0]
        return {'success': True, 'source': 'iem', 'station': station,
                'valid': p0.get('valid'), 'profile': p0['profile']}
    return {'success': False, 'error': 'no sounding data for that station/time', 'profile': []}


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            q = parse_qs(urlparse(self.path).query)
            station = (q.get('station', [''])[0] or '').upper()
            wmo = q.get('wmo', [''])[0]
            ts = q.get('ts', [''])[0]
            if not station or not ts:
                raise ValueError('station and ts are required')
            result = get_raob(wmo, station, ts)
            body = json.dumps(result).encode()
            self.send_response(200 if result.get('success') else 404)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            # Soundings publish only at 00Z/12Z — cache hard.
            self.send_header('Cache-Control', 'public, max-age=600, s-maxage=1800')
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:
            self.send_response(502)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({'success': False, 'error': str(e), 'profile': []}).encode())
