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
    _mark_graduated(storms)
    return storms


def _latest_pos(sid):
    """(lat, lon) of a storm's newest best-track fix, or None."""
    try:
        txt = _fetch(f'https://ftp.nhc.noaa.gov/atcf/btk/b{sid}.dat', timeout=10).decode('utf-8', errors='replace')
        for ln in reversed(txt.splitlines()):
            p = ln.split(',')
            if len(p) > 7 and p[4].strip() == 'BEST':
                la, lo = p[6].strip(), p[7].strip()
                lat = int(la[:-1]) / 10 * (-1 if la.endswith('S') else 1)
                lon = int(lo[:-1]) / 10 * (-1 if lo.endswith('W') else 1)
                return (lat, lon)
    except Exception:
        return None
    return None


def _mark_graduated(storms):
    """Flag an invest as graduated when a numbered storm in the same basin sits
    on top of it (invest AL91 upgraded to TD AL02 → both files linger). Only
    probes positions for basins that actually have both, to stay cheap."""
    for basin in {s['basin'] for s in storms}:
        grp = [s for s in storms if s['basin'] == basin]
        invests = [s for s in grp if s['invest']]
        numbered = [s for s in grp if not s['invest']]
        if not invests or not numbered:
            continue
        for s in grp:
            s['_pos'] = _latest_pos(s['id'])
        for inv in invests:
            if not inv['_pos']:
                continue
            for n in numbered:
                if n['_pos'] and abs(n['_pos'][0] - inv['_pos'][0]) < 0.6 and abs(n['_pos'][1] - inv['_pos'][1]) < 0.6:
                    inv['graduated_to'] = n['id']
                    break
    for s in storms:
        s.pop('_pos', None)


def fetch_btk(sid):
    """Return the b-deck (best track) text — the storm's analyzed life history,
    updated with every advisory. Small file, not gzipped."""
    if not re.fullmatch(r'(al|ep|cp)\d{6}', sid):
        raise ValueError('bad storm id')
    return _fetch(f'https://ftp.nhc.noaa.gov/atcf/btk/b{sid}.dat').decode('utf-8', errors='replace')


def fetch_rip(sid):
    """Return the newest CIRA rapid-intensification / decapitation guidance
    (ripastbl) for one storm. Filenames are timestamped by synoptic cycle;
    directory listing is disabled, so probe recent 6-hourly cycles."""
    if not re.fullmatch(r'(al|ep|cp)\d{6}', sid):
        raise ValueError('bad storm id')
    stormdir = f'{sid[4:8]}{sid[:2]}{sid[2:4]}'   # al022026 -> 2026al02
    base = datetime.datetime.utcnow().replace(minute=0, second=0, microsecond=0)
    base -= datetime.timedelta(hours=base.hour % 6)
    for k in range(6):   # newest cycle first, ~30 h back
        stamp = (base - datetime.timedelta(hours=6 * k)).strftime('%Y%m%d%H%M')
        url = (f'https://rammb-data.cira.colostate.edu/tc_realtime/products/'
               f'storms/{stormdir}/ripastbl/{stormdir}_ripastbl_{stamp}.txt')
        try:
            return _fetch(url).decode('utf-8', errors='replace')
        except Exception:
            continue
    raise ValueError('no RI guidance for this system yet')


def fetch_ships(sid):
    """Return the newest SHIPS diagnostic text for one storm. NHC files are
    named {YYMMDDHH}{BASIN}{NN}{YY}_ships.txt (e.g. 26071912AL0226_ships.txt);
    list the dir and grab the most recent for this system."""
    if not re.fullmatch(r'(al|ep|cp)\d{6}', sid):
        raise ValueError('bad storm id')
    token = f'{sid[:2].upper()}{sid[2:4]}{sid[6:8]}'   # al022026 -> AL0226
    idx = _fetch('https://ftp.nhc.noaa.gov/atcf/stext/').decode('utf-8', errors='replace')
    files = re.findall(rf'(\d{{8}}{token}_ships\.txt)', idx)
    if not files:
        raise ValueError('no SHIPS diagnostics for this system yet')
    newest = sorted(set(files))[-1]
    return _fetch(f'https://ftp.nhc.noaa.gov/atcf/stext/{newest}').decode('utf-8', errors='replace')


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
            elif q.get('btk', [''])[0]:
                body = fetch_btk(q.get('btk', [''])[0].lower()).encode()
                ctype = 'text/plain'
            elif q.get('ships', [''])[0]:
                body = fetch_ships(q.get('ships', [''])[0].lower()).encode()
                ctype = 'text/plain'
            elif q.get('rip', [''])[0]:
                body = fetch_rip(q.get('rip', [''])[0].lower()).encode()
                ctype = 'text/plain'
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
