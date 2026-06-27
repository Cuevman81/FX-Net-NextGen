"""
NEXRAD Level III radar from NOAA Open Data Dissemination (NODD), decoded and
rendered to a transparent, georeferenced PNG for overlay on the MapLibre map.

Dependency-free decode (stdlib only) — MetPy's full stack (scipy/pandas/xarray/
matplotlib, ~300 MB) does not fit Vercel's serverless limit. The decoder here is
validated byte-for-byte against MetPy. Render uses numpy + Pillow only.

GET /api/radar-l3?station=KDGX&product=N0B
  -> { success, image: "data:image/png;base64,...",
       coordinates: [[lon,lat] x4 tl,tr,br,bl], meta: {...} }
"""
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
from datetime import datetime, timezone, timedelta
import urllib.request
import xml.etree.ElementTree as ET
import struct
import bz2
import io
import json
import base64
import math

import numpy as np
from PIL import Image

L3_BUCKET = 'https://unidata-nexrad-level3.s3.amazonaws.com'

# Per-product calibration. value = scale*code + offset for code>=2 (codes 0,1 are
# below-threshold / range-folded -> transparent). gate_km = range-bin spacing.
# Derived from and validated against MetPy (max abs diff <= 1e-4).
CAL = {
    'N0B': dict(scale=0.5,      offset=-33.0,   gate_km=0.25, name='Base Reflectivity',           units='dBZ'),
    'N0G': dict(scale=0.5,      offset=-64.5,   gate_km=0.25, name='Base Velocity',               units='kt'),
    'N0C': dict(scale=0.003333, offset=0.20167, gate_km=0.25, name='Correlation Coefficient',     units=''),
    'N0X': dict(scale=0.0625,   offset=-8.0,    gate_km=0.25, name='Differential Reflectivity',   units='dB'),
    'N0K': dict(scale=0.05,     offset=-2.15,   gate_km=0.25, name='Specific Differential Phase', units='deg/km'),
}

# ── Color tables: list of (value_threshold, (r,g,b)). Bucketed (NWS-style). ──
REF_STOPS = [(5,(4,233,231)),(10,(1,159,244)),(15,(3,0,244)),(20,(2,253,2)),
             (25,(1,197,1)),(30,(0,142,0)),(35,(253,248,2)),(40,(229,188,0)),
             (45,(253,149,0)),(50,(253,0,0)),(55,(212,0,0)),(60,(188,0,0)),
             (65,(248,0,253)),(70,(152,84,198)),(75,(255,255,255))]
VEL_STOPS = [(-64,(0,224,224)),(-50,(0,160,140)),(-36,(0,200,0)),(-26,(0,255,0)),
             (-16,(0,128,0)),(-6,(0,72,0)),(-1,(40,40,40)),(1,(60,30,30)),
             (6,(72,0,0)),(16,(128,0,0)),(26,(255,0,0)),(36,(255,128,0)),
             (50,(255,200,0)),(64,(255,255,0))]
CC_STOPS  = [(0.20,(50,50,90)),(0.60,(70,70,160)),(0.80,(0,150,180)),(0.90,(0,200,0)),
             (0.93,(180,200,0)),(0.95,(230,200,0)),(0.97,(230,130,0)),
             (0.99,(220,40,0)),(1.02,(220,0,160)),(1.05,(255,0,255))]
ZDR_STOPS = [(-8,(60,60,120)),(-2,(40,90,200)),(-0.5,(120,180,230)),(0.5,(220,220,220)),
             (1.5,(255,220,90)),(3,(255,150,0)),(5,(230,30,30)),(8,(255,0,255))]
KDP_STOPS = [(-2,(60,60,120)),(-0.5,(120,160,220)),(0.25,(220,220,220)),(1,(120,220,120)),
             (2,(255,230,80)),(4,(255,140,0)),(7,(220,0,0))]
STOPS = {'N0B':REF_STOPS,'N0G':VEL_STOPS,'N0C':CC_STOPS,'N0X':ZDR_STOPS,'N0K':KDP_STOPS}

# ── 16-level (legacy graphic) products: code-indexed, NOT linearly calibrated ──
# Storm Relative Mean Radial Velocity (NEXRAD product 56, N0S) ships as a 16-data-
# level run-length packet (0xAF1F), not the 256-level digital radial array the
# products above use. Each bin carries a data code 0-15 that indexes a FIXED
# velocity ladder defined in the product's own threshold table (verified against a
# live N0S file): code 0 = ND, 1-7 = outbound +64..+1 kt, 8 = 0, 9-14 = inbound
# -10..-64 kt, 15 = RF (range folded). AWIPS uses the base-velocity color indices
# for SRM, so this palette mirrors VEL_STOPS: green inbound, gray near zero,
# red/yellow outbound, magenta for range-folded. Index 0 renders transparent.
V16 = {
    'N0S': dict(name='Storm Rel Velocity', units='kt'),
}
SRM_PALETTE = [
    (0, 0, 0),      # 0  ND            (transparent)
    (255, 255, 0),  # 1  +64 kt outbound (strongest)
    (255, 200, 0),  # 2  +50
    (255, 128, 0),  # 3  +36
    (255, 0, 0),    # 4  +26
    (208, 0, 0),    # 5  +20
    (160, 0, 0),    # 6  +10
    (96, 16, 16),   # 7  +1            (weak outbound)
    (80, 80, 80),   # 8  0             (zero)
    (0, 72, 0),     # 9  -10           (weak inbound)
    (0, 120, 0),    # 10 -20
    (0, 180, 0),    # 11 -26
    (0, 230, 0),    # 12 -36
    (0, 200, 160),  # 13 -50
    (0, 224, 224),  # 14 -64 kt inbound (strongest)
    (170, 90, 210), # 15 RF            (range folded)
]


def fetch_latest_key(station, product):
    st3 = station[1:].upper() if (len(station) == 4 and station[0].upper() == 'K') else station.upper()
    now = datetime.now(timezone.utc)
    for day_off in (0, 1):
        d = now - timedelta(days=day_off)
        url = f"{L3_BUCKET}/?prefix={st3}_{product}_{d:%Y_%m_%d}_"
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'FXNet-Proxy/1.0'})
            xml = urllib.request.urlopen(req, timeout=15).read()
            ns = {'s3': 'http://s3.amazonaws.com/doc/2006-03-01/'}
            keys = [c.find('s3:Key', ns).text for c in ET.fromstring(xml).findall('s3:Contents', ns)]
            if keys:
                return sorted(keys)[-1]
        except Exception:
            continue
    return None


def decode_l3(raw, product):
    cal = CAL[product]
    # locate Product Description Block (first 0xFFFF divider w/ CONUS lat/lon)
    pdb = None
    for o in range(0, 200):
        if raw[o:o + 2] == b'\xff\xff':
            lat = struct.unpack_from('>i', raw, o + 2)[0] / 1000.0
            lon = struct.unpack_from('>i', raw, o + 6)[0] / 1000.0
            if 15 < lat < 72 and -170 < lon < -60:
                pdb = o
                break
    if pdb is None:
        raise ValueError('PDB not found')
    lat = struct.unpack_from('>i', raw, pdb + 2)[0] / 1000.0
    lon = struct.unpack_from('>i', raw, pdb + 6)[0] / 1000.0
    el = struct.unpack_from('>h', raw, pdb + 40)[0] / 10.0
    prod_time = _read_prod_time(raw, pdb)

    bzpos = raw.find(b'BZh', pdb)
    sym = bz2.BZ2Decompressor().decompress(raw[bzpos:]) if 0 < bzpos else raw[pdb + 102:]

    off = 2 + 2 + 4 + 2  # symbology block header
    off += 2 + 4         # layer header
    pcode = struct.unpack_from('>H', sym, off)[0]
    off += 2
    if pcode != 16:
        raise ValueError(f'unsupported packet code {pcode}')
    first_bin, num_bins, ic, jc, rscale, num_rad = struct.unpack_from('>HHhhHH', sym, off)
    off += 12
    az = np.empty(num_rad, np.float32)
    codes = np.zeros((num_rad, num_bins), np.uint8)
    for r in range(num_rad):
        nbytes, sa, da = struct.unpack_from('>HHH', sym, off)
        off += 6
        az[r] = sa / 10.0
        row = np.frombuffer(sym, np.uint8, nbytes, off)
        off += nbytes
        codes[r, :min(nbytes, num_bins)] = row[:num_bins]
    vals = np.where(codes >= 2, cal['scale'] * codes.astype(np.float32) + cal['offset'], np.nan)
    return dict(lat=lat, lon=lon, el=el, num_bins=num_bins, num_rad=num_rad,
                gate_km=cal['gate_km'], max_range=num_bins * cal['gate_km'],
                az=az, data=vals, name=cal['name'], units=cal['units'], time=prod_time)


def _read_prod_time(raw, pdb):
    try:
        gen_date = struct.unpack_from('>H', raw, pdb + 28)[0]  # days since 1970-01-01 (day 1 = epoch)
        gen_time = struct.unpack_from('>i', raw, pdb + 30)[0]  # seconds since midnight UTC
        return (datetime(1970, 1, 1, tzinfo=timezone.utc) + timedelta(days=gen_date - 1, seconds=gen_time)).strftime('%Y-%m-%d %H:%M:%SZ')
    except Exception:
        return ''


# Render near the radar's native gate resolution so it stays crisp when zoomed,
# capped so render time / payload stay reasonable. Output is a palette-mode PNG
# (index 0 = transparent) — exact discrete colors at ~half the size of RGBA.
RENDER_CAP = 3400


def render(dec, product):
    rlat, rlon, maxr = dec['lat'], dec['lon'], dec['max_range']
    coslat = math.cos(math.radians(rlat))
    # pixel size ~ gate size (native); capped
    size = int(min(round(2 * maxr / dec['gate_km']), RENDER_CAP))
    dlat = maxr / 111.32
    dlon = maxr / (111.32 * coslat)

    # 1-D axes -> 2-D range/azimuth via broadcasting (avoids full lon/lat meshgrids)
    ykm = ((np.linspace(rlat + dlat, rlat - dlat, size, dtype=np.float32) - rlat) * 111.32).reshape(size, 1)
    xkm = ((np.linspace(rlon - dlon, rlon + dlon, size, dtype=np.float32) - rlon) * (111.32 * coslat)).reshape(1, size)
    rng = np.sqrt(xkm * xkm + ykm * ykm)                       # (size,size) f32
    azp = (np.degrees(np.arctan2(np.broadcast_to(xkm, rng.shape),
                                 np.broadcast_to(ykm, rng.shape))) % 360.0)
    nrad = dec['num_rad']
    ri = np.round((azp - dec['az'][0]) * (nrad / 360.0)).astype(np.int32) % nrad
    del azp
    gi = (rng / dec['gate_km']).astype(np.int32)
    inside = (gi < dec['num_bins']) & (rng <= maxr)
    del rng
    grid = np.full((size, size), np.nan, np.float32)
    grid[inside] = dec['data'][ri[inside], gi[inside]]
    del ri, gi, inside

    # palette indices: 0 = transparent, 1..N = color buckets
    stops = STOPS[product]
    thr = np.array([s[0] for s in stops], dtype=np.float32)
    bucket = np.clip(np.digitize(grid, thr), 0, len(stops))   # 0 below first threshold
    valid = ~np.isnan(grid) & (grid >= thr[0])
    idx = np.where(valid, bucket, 0).astype(np.uint8)
    del grid, bucket, valid

    palette = [0, 0, 0]
    for _, (r, g, b) in stops:
        palette += [r, g, b]
    img = Image.fromarray(idx, 'P')
    img.putpalette(palette)
    buf = io.BytesIO()
    img.save(buf, format='PNG', optimize=True, transparency=0)

    coords = [[rlon - dlon, rlat + dlat], [rlon + dlon, rlat + dlat],
              [rlon + dlon, rlat - dlat], [rlon - dlon, rlat - dlat]]
    return buf.getvalue(), coords


def decode_l3_v16(raw, product):
    """Decode a 16-data-level radial product (packet 0xAF1F), e.g. N0S (SRM).

    Unlike decode_l3, the bins hold 4-bit data CODES (0-15) — not values — so we
    carry the code grid through to render and color it via SRM_PALETTE directly.
    """
    meta = V16[product]
    pdb = None
    for o in range(0, 200):
        if raw[o:o + 2] == b'\xff\xff':
            lat = struct.unpack_from('>i', raw, o + 2)[0] / 1000.0
            lon = struct.unpack_from('>i', raw, o + 6)[0] / 1000.0
            if 15 < lat < 72 and -170 < lon < -60:
                pdb = o
                break
    if pdb is None:
        raise ValueError('PDB not found')
    lat = struct.unpack_from('>i', raw, pdb + 2)[0] / 1000.0
    lon = struct.unpack_from('>i', raw, pdb + 6)[0] / 1000.0
    el = struct.unpack_from('>h', raw, pdb + 40)[0] / 10.0
    # Product-56 dependent halfwords: storm-motion vector subtracted to form SRM.
    storm_spd = struct.unpack_from('>h', raw, pdb + 82)[0] / 10.0   # kt
    storm_dir = struct.unpack_from('>h', raw, pdb + 84)[0] / 10.0   # deg
    prod_time = _read_prod_time(raw, pdb)

    # Legacy graphic products are usually uncompressed; honor BZh if present.
    bzpos = raw.find(b'BZh', pdb)
    sym = bz2.BZ2Decompressor().decompress(raw[bzpos:]) if 0 < bzpos else raw[pdb + 102:]

    off = 2 + 2 + 4 + 2  # symbology block header
    off += 2 + 4         # layer header
    pcode = struct.unpack_from('>H', sym, off)[0]
    off += 2
    if pcode != 0xAF1F:
        raise ValueError(f'unsupported packet code {pcode:#x}')
    first_bin, num_bins, ic, jc, rscale, num_rad = struct.unpack_from('>hHhhHH', sym, off)
    off += 12
    gate_km = (rscale or 1000) / 1000.0
    az = np.empty(num_rad, np.float32)
    codes = np.zeros((num_rad, num_bins), np.uint8)
    for r in range(num_rad):
        rle_half, sa, da = struct.unpack_from('>HHH', sym, off)
        off += 6
        az[r] = sa / 10.0
        nbytes = rle_half * 2  # run-length bytes: high nibble = run, low nibble = code
        row = np.frombuffer(sym, np.uint8, nbytes, off)
        off += nbytes
        bins = np.repeat(row & 0x0F, row >> 4)[:num_bins]
        codes[r, :bins.size] = bins
    return dict(lat=lat, lon=lon, el=el, num_bins=num_bins, num_rad=num_rad,
                gate_km=gate_km, max_range=num_bins * gate_km, az=az, codes=codes,
                name=meta['name'], units=meta['units'], time=prod_time,
                storm_dir=storm_dir, storm_spd=storm_spd)


def render_v16(dec):
    """Resample the polar CODE grid to a palette PNG (index 0 = transparent)."""
    rlat, rlon, maxr = dec['lat'], dec['lon'], dec['max_range']
    coslat = math.cos(math.radians(rlat))
    size = int(min(round(2 * maxr / dec['gate_km']), RENDER_CAP))
    dlat = maxr / 111.32
    dlon = maxr / (111.32 * coslat)
    ykm = ((np.linspace(rlat + dlat, rlat - dlat, size, dtype=np.float32) - rlat) * 111.32).reshape(size, 1)
    xkm = ((np.linspace(rlon - dlon, rlon + dlon, size, dtype=np.float32) - rlon) * (111.32 * coslat)).reshape(1, size)
    rng = np.sqrt(xkm * xkm + ykm * ykm)
    azp = (np.degrees(np.arctan2(np.broadcast_to(xkm, rng.shape),
                                 np.broadcast_to(ykm, rng.shape))) % 360.0)
    nrad = dec['num_rad']
    ri = np.round((azp - dec['az'][0]) * (nrad / 360.0)).astype(np.int32) % nrad
    del azp
    gi = (rng / dec['gate_km']).astype(np.int32)
    inside = (gi < dec['num_bins']) & (rng <= maxr)
    del rng
    idx = np.zeros((size, size), np.uint8)
    idx[inside] = dec['codes'][ri[inside], gi[inside]]
    del ri, gi, inside

    palette = []
    for (r, g, b) in SRM_PALETTE:
        palette += [r, g, b]
    img = Image.fromarray(idx, 'P')
    img.putpalette(palette)
    buf = io.BytesIO()
    img.save(buf, format='PNG', optimize=True, transparency=0)

    coords = [[rlon - dlon, rlat + dlat], [rlon + dlon, rlat + dlat],
              [rlon + dlon, rlat - dlat], [rlon - dlon, rlat - dlat]]
    return buf.getvalue(), coords


def build_radar(station, product):
    if product not in CAL and product not in V16:
        raise ValueError(f'unsupported product {product}')
    key = fetch_latest_key(station, product)
    if not key:
        raise ValueError(f'no recent {product} data for {station}')
    req = urllib.request.Request(f"{L3_BUCKET}/{key}", headers={'User-Agent': 'FXNet-Proxy/1.0'})
    raw = urllib.request.urlopen(req, timeout=25).read()
    if product in V16:
        dec = decode_l3_v16(raw, product)
        png, coords = render_v16(dec)
        meta = {
            'station': station, 'product': product, 'name': dec['name'], 'units': dec['units'],
            'elevation': dec['el'], 'time': dec['time'], 'max_range_km': dec['max_range'],
            'storm_dir': dec['storm_dir'], 'storm_spd': dec['storm_spd'], 'key': key,
        }
    else:
        dec = decode_l3(raw, product)
        png, coords = render(dec, product)
        meta = {
            'station': station, 'product': product, 'name': dec['name'], 'units': dec['units'],
            'elevation': dec['el'], 'time': dec['time'], 'max_range_km': dec['max_range'],
            'key': key,
        }
    return {
        'success': True,
        'image': 'data:image/png;base64,' + base64.b64encode(png).decode(),
        'coordinates': coords,
        'meta': meta,
    }


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            qs = parse_qs(urlparse(self.path).query)
            station = qs.get('station', ['KDGX'])[0].upper()
            product = qs.get('product', ['N0B'])[0].upper()
            body = json.dumps(build_radar(station, product)).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Cache-Control', 'public, max-age=30')
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:
            self.send_response(500)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({'success': False, 'error': str(e)}).encode())
