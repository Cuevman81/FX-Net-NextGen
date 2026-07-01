from http.server import BaseHTTPRequestHandler
import urllib.request
import io
import json
import struct
import zipfile
import datetime

# WPC Mesoscale Precipitation Discussions (AWIPS FFGMPD). No clean "active" GeoJSON
# feed exists (not in api.weather.gov, not in NOAA mapservices), so pull the recent
# window from the IEM GIS archive (zipped shapefile) and filter to currently-active.
IEM_MPD = 'https://mesonet.agron.iastate.edu/cgi-bin/request/gis/wpc_mpd.py'

MPD_FILL = '#33c27a'   # green, distinct from the reddish SPC mesoscale-discussion color


def _read_dbf(data):
    numrec, hdrlen, reclen = struct.unpack('<IHH', data[4:12])
    fields = []
    pos = 32
    while data[pos] != 0x0D:
        name = data[pos:pos + 11].split(b'\x00')[0].decode('latin1')
        flen = data[pos + 16]
        fields.append((name, flen))
        pos += 32
    records = []
    start = hdrlen
    for r in range(numrec):
        off = start + r * reclen + 1  # +1 skips the deletion flag
        rec = {}
        p = off
        for name, flen in fields:
            rec[name] = data[p:p + flen].decode('latin1').strip()
            p += flen
        records.append(rec)
    return records


def _read_shp_polygons(data):
    # Returns a list (one per record) of ring-lists; each ring is [[lon,lat],...].
    polys = []
    pos = 100  # main file header
    n = len(data)
    while pos + 8 <= n:
        _recnum, clen = struct.unpack('>ii', data[pos:pos + 8])
        pos += 8
        content = data[pos:pos + clen * 2]
        pos += clen * 2
        if len(content) < 4:
            polys.append([])
            continue
        shape_type = struct.unpack('<i', content[0:4])[0]
        if shape_type != 5:  # only Polygon
            polys.append([])
            continue
        num_parts, num_points = struct.unpack('<ii', content[36:44])
        pp = 44
        parts = list(struct.unpack('<%di' % num_parts, content[pp:pp + 4 * num_parts]))
        pp += 4 * num_parts
        pts = struct.unpack('<%dd' % (num_points * 2), content[pp:pp + 16 * num_points])
        rings = []
        bounds = parts + [num_points]
        for i in range(num_parts):
            ring = []
            for j in range(bounds[i], bounds[i + 1]):
                ring.append([pts[2 * j], pts[2 * j + 1]])
            if len(ring) >= 4:
                rings.append(ring)
        polys.append(rings)
    return polys


def fetch_active_mpds():
    now = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
    sts = (now - datetime.timedelta(hours=36)).strftime('%Y-%m-%dT%H:%MZ')
    ets = (now + datetime.timedelta(hours=1)).strftime('%Y-%m-%dT%H:%MZ')
    url = f'{IEM_MPD}?sts={sts}&ets={ets}&format=shp'
    req = urllib.request.Request(url, headers={'User-Agent': 'FXNet-Proxy/1.0'})
    with urllib.request.urlopen(req, timeout=25) as r:
        raw = r.read()

    zf = zipfile.ZipFile(io.BytesIO(raw))
    shp_name = next(n for n in zf.namelist() if n.lower().endswith('.shp'))
    dbf_name = next(n for n in zf.namelist() if n.lower().endswith('.dbf'))
    records = _read_dbf(zf.read(dbf_name))
    polys = _read_shp_polygons(zf.read(shp_name))

    nowstamp = now.strftime('%Y%m%d%H%M')
    features = []
    for rec, rings in zip(records, polys):
        if not rings:
            continue
        issue = rec.get('ISSUE', '')
        expire = rec.get('EXPIRE', '')
        # currently active: issued at/before now and not yet expired
        if not (issue and expire and issue <= nowstamp <= expire):
            continue
        num = rec.get('NUM', '')
        year = rec.get('YEAR', '')
        link = ''
        if num and year:
            link = f'https://www.wpc.ncep.noaa.gov/metwatch/metwatch_mpd_multi.php?md={int(num):04d}&yr={year}'
        features.append({
            'type': 'Feature',
            'properties': {
                'num': num,
                'concern': rec.get('CONCERN', ''),
                'issue': issue,
                'expire': expire,
                'year': year,
                'prodId': rec.get('PROD_ID', ''),
                'link': link,
                'fill': MPD_FILL,
                'stroke': MPD_FILL,
            },
            'geometry': {'type': 'Polygon', 'coordinates': rings},
        })
    return {'type': 'FeatureCollection', 'features': features}


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            body = json.dumps(fetch_active_mpds()).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            # MPDs are sporadic; 1 min browser / 5 min CDN keeps the IEM fetch rare.
            self.send_header('Cache-Control', 'public, max-age=60, s-maxage=300')
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:
            self.send_response(500)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({'error': str(e)}).encode())
