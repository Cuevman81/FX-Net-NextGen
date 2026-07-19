from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
import urllib.request
import datetime
import gzip
import json
import re

# NHC ATCF "a-deck" model guidance proxy. ftp.nhc.noaa.gov sends no CORS
# headers, so the browser can't fetch these directly. Two modes:
#   ?list=1      -> JSON list of active systems (current-year a-decks with a
#                   recent Last-Modified in the aid_public Apache index)
#   ?id=al912026 -> the storm's a-deck trimmed to the latest 3 forecast
#                   cycles (full-season decks for long-lived storms exceed
#                   1 MB; 3 cycles keeps the payload small and still covers
#                   late-arriving model runs from earlier cycles)

AID_PUBLIC = 'https://ftp.nhc.noaa.gov/atcf/aid_public/'
ACTIVE_WINDOW_HOURS = 96


def _fetch(url, timeout=20):
    req = urllib.request.Request(url, headers={'User-Agent': 'FXNet-VercelProxy/1.0'})
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return response.read()


def list_storms():
    """Parse the aid_public index for current-year al/ep/cp decks with a
    recent modification time — i.e. systems models are actively tracking."""
    html = _fetch(AID_PUBLIC).decode('utf-8', errors='replace')
    year = datetime.datetime.utcnow().year
    cutoff = datetime.datetime.utcnow() - datetime.timedelta(hours=ACTIVE_WINDOW_HOURS)
    storms = []
    # Index rows look like: <a href="aal912026.dat.gz">…</a>   2026-07-18 18:53   10K
    for m in re.finditer(
            r'href="a((al|ep|cp)(\d{2})(\d{4}))\.dat\.gz"[^>]*>[^<]*</a>\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2})',
            html):
        sid, basin, num, yr, mtime = m.group(1), m.group(2), m.group(3), m.group(4), m.group(5)
        if int(yr) != year:
            continue
        try:
            mod = datetime.datetime.strptime(mtime.strip(), '%Y-%m-%d %H:%M')
        except ValueError:
            continue
        if mod < cutoff:
            continue
        storms.append({
            'id': sid,
            'basin': basin.upper(),
            'num': int(num),
            'invest': int(num) >= 90,
            'modified': mod.strftime('%Y-%m-%dT%H:%MZ')
        })
    storms.sort(key=lambda s: (s['basin'], s['num']))
    return storms


def fetch_adeck(sid):
    """Return the a-deck text for one storm, trimmed to the latest 3 cycles."""
    if not re.fullmatch(r'(al|ep|cp)\d{6}', sid):
        raise ValueError('bad storm id')
    raw = gzip.decompress(_fetch(f'{AID_PUBLIC}a{sid}.dat.gz'))
    lines = raw.decode('utf-8', errors='replace').splitlines()
    dtgs = set()
    for ln in lines:
        parts = ln.split(',')
        if len(parts) > 2:
            dtg = parts[2].strip()
            if len(dtg) == 10 and dtg.isdigit():
                dtgs.add(dtg)
    keep = set(sorted(dtgs)[-3:])
    out = [ln for ln in lines if len(ln.split(',')) > 2 and ln.split(',')[2].strip() in keep]
    return '\n'.join(out)


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            q = parse_qs(urlparse(self.path).query)
            if q.get('list', [''])[0]:
                body = json.dumps({'storms': list_storms()}).encode()
                ctype = 'application/json'
            else:
                sid = q.get('id', [''])[0].lower()
                body = fetch_adeck(sid).encode()
                ctype = 'text/plain'
            self.send_response(200)
            self.send_header('Content-Type', ctype)
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Cache-Control', 'public, max-age=300')
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:
            self.send_response(500)
            self.send_header('Content-Type', 'text/plain')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(str(e).encode())
