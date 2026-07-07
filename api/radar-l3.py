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
import re
import struct
import bz2
import io
import json
import base64
import math

import numpy as np
from PIL import Image

L3_BUCKET = 'https://unidata-nexrad-level3.s3.amazonaws.com'
_STATION_RE = re.compile(r'^[A-Z0-9]{3,4}$')   # guard against URL injection

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

# ── All-tilts: elevation variants share their base moment's calibration/palette ──
# L3 mnemonics are [N][tilt][moment]. For the super-res digital moments the tilt
# characters run 0→A→1→B (≈0.5/0.9/1.3/1.8°, per the live NODD bucket); the
# legacy digit-only names continue upward (N2C=2.4°, N3C=3.4°). Velocity's
# higher cuts arrive as the conventional 256-level product 99 (N2U/N3U) — same
# 0.5 kt / −64.5 encoding as N0G. Availability depends on the active VCP.
for _base, _variants in {'N0B': ('NAB', 'N1B', 'NBB', 'N2B', 'N3B'),
                         'N0G': ('NAG', 'N1G', 'NBG', 'N2G', 'N3G', 'N1U', 'N2U', 'N3U'),
                         'N0C': ('NAC', 'N1C', 'NBC', 'N2C', 'N3C'),
                         'N0X': ('NAX', 'N1X', 'NBX', 'N2X', 'N3X'),
                         'N0K': ('NAK', 'N1K', 'NBK', 'N2K', 'N3K')}.items():
    for _v in _variants:
        CAL[_v] = CAL[_base]
        STOPS[_v] = STOPS[_base]
for _v in ('NAS', 'N1S', 'NBS', 'N2S', 'N3S'):
    V16[_v] = V16['N0S']


def fetch_latest_key(station, product, offset=0):
    """Newest key for a station/product, or the offset-th scan back (0 = latest).
    Offsets past today's scans continue into yesterday's."""
    st3 = station[1:].upper() if (len(station) == 4 and station[0].upper() == 'K') else station.upper()
    now = datetime.now(timezone.utc)
    all_keys = []
    for day_off in (0, 1):
        d = now - timedelta(days=day_off)
        url = f"{L3_BUCKET}/?prefix={st3}_{product}_{d:%Y_%m_%d}_"
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'FXNet-Proxy/1.0'})
            xml = urllib.request.urlopen(req, timeout=15).read()
            ns = {'s3': 'http://s3.amazonaws.com/doc/2006-03-01/'}
            keys = [c.find('s3:Key', ns).text for c in ET.fromstring(xml).findall('s3:Contents', ns)]
            all_keys = sorted(keys) + all_keys   # yesterday's sort before today's
        except Exception:
            continue
        if len(all_keys) > offset:
            break                                 # today already covers the offset
    if len(all_keys) > offset:
        return all_keys[-1 - offset]
    return None


def decode_l3(raw, product):
    cal = CAL[product]
    pdb, lat, lon, sym = _pdb_and_buf(raw)
    el = struct.unpack_from('>h', raw, pdb + 40)[0] / 10.0
    prod_time = _read_prod_time(raw, pdb)

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


def _resample_polar(dec):
    """Map each output pixel of a north-up square around the radar to its
    (radial, gate) index. Shared by the 256-level and 16-level renderers.
    Returns (size, ri, gi, inside, coords)."""
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
    coords = [[rlon - dlon, rlat + dlat], [rlon + dlon, rlat + dlat],
              [rlon + dlon, rlat - dlat], [rlon - dlon, rlat - dlat]]
    return size, ri, gi, inside, coords


def _palette_png(idx, colors):
    """Encode a uint8 index grid as a palette PNG with index 0 transparent."""
    palette = []
    for (r, g, b) in colors:
        palette += [r, g, b]
    img = Image.fromarray(idx, 'P')
    img.putpalette(palette)
    buf = io.BytesIO()
    img.save(buf, format='PNG', optimize=True, transparency=0)
    return buf.getvalue()


def render(dec, product):
    size, ri, gi, inside, coords = _resample_polar(dec)
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

    return _palette_png(idx, [(0, 0, 0)] + [c for _, c in stops]), coords


def decode_l3_v16(raw, product):
    """Decode a 16-data-level radial product (packet 0xAF1F), e.g. N0S (SRM).

    Unlike decode_l3, the bins hold 4-bit data CODES (0-15) — not values — so we
    carry the code grid through to render and color it via SRM_PALETTE directly.
    """
    meta = V16[product]
    pdb, lat, lon, sym = _pdb_and_buf(raw)
    el = struct.unpack_from('>h', raw, pdb + 40)[0] / 10.0
    # Product-56 dependent halfwords: storm-motion vector subtracted to form SRM.
    storm_spd = struct.unpack_from('>h', raw, pdb + 82)[0] / 10.0   # kt
    storm_dir = struct.unpack_from('>h', raw, pdb + 84)[0] / 10.0   # deg
    prod_time = _read_prod_time(raw, pdb)

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
    size, ri, gi, inside, coords = _resample_polar(dec)
    idx = np.zeros((size, size), np.uint8)
    idx[inside] = dec['codes'][ri[inside], gi[inside]]
    del ri, gi, inside
    return _palette_png(idx, SRM_PALETTE), coords


# ─────────────────────────────────────────────────────────────────────────────
# Graphic-alphanumeric products: storm tracks (NST) and VAD wind profile (NVW).
# These carry vector/tabular data, not a raster, so they return JSON/GeoJSON.
# ─────────────────────────────────────────────────────────────────────────────

def _pdb_and_buf(raw):
    """Locate the Product Description Block, return radar lat/lon + decompressed body."""
    pdb = None
    for o in range(0, 300):
        if raw[o:o + 2] == b'\xff\xff':
            lat = struct.unpack_from('>i', raw, o + 2)[0] / 1000.0
            lon = struct.unpack_from('>i', raw, o + 6)[0] / 1000.0
            if 15 < lat < 72 and -170 < lon < -60:
                pdb = o
                break
    if pdb is None:
        raise ValueError('PDB not found')
    rlat = struct.unpack_from('>i', raw, pdb + 2)[0] / 1000.0
    rlon = struct.unpack_from('>i', raw, pdb + 6)[0] / 1000.0
    bzpos = raw.find(b'BZh', pdb)
    buf = bz2.BZ2Decompressor().decompress(raw[bzpos:]) if 0 < bzpos else raw[pdb + 102:]
    return pdb, rlat, rlon, buf


def _iter_blocks(buf):
    """Yield (block_id, start, length) for each contiguous top-level block."""
    pos, n = 0, 0
    while pos + 8 <= len(buf) and n < 6:
        if buf[pos:pos + 2] != b'\xff\xff':
            break
        bid = struct.unpack_from('>H', buf, pos + 2)[0]
        blen = struct.unpack_from('>I', buf, pos + 4)[0]
        if blen <= 0 or pos + blen > len(buf):
            break
        yield bid, pos, blen
        pos += blen
        n += 1


def _ij_to_lonlat(i, j, rlat, rlon):
    # Special-symbol coordinates are in 1/4 km east (I) / north (J) of the radar.
    lat = rlat + (j / 4.0) / 111.32
    lon = rlon + (i / 4.0) / (111.32 * math.cos(math.radians(rlat)))
    return lon, lat


def _parse_nst_table(text):
    """Parse the STI attribute table (movement, max dBZ, top) keyed by cell ID."""
    # Tabular-block lines are length-prefixed (not newline-separated); the count's
    # high byte is non-printable, so each printable run is one table line.
    cells, ids = {}, []
    for ln in re.findall(r'[ -~]{10,}', text):
        if 'STORM ID' in ln:
            ids = ln.split('STORM ID', 1)[1].split()
            for c in ids:
                cells.setdefault(c, {})
        elif 'AZ/RAN' in ln and ids:
            for c, (az, ran) in zip(ids, re.findall(r'(\d+)/\s*(\d+)', ln)):
                cells[c]['az'], cells[c]['ran'] = int(az), int(ran)
        elif 'FCST MVT' in ln and ids:
            for c, tok in zip(ids, re.findall(r'(\d+/\s*\d+|NEW)', ln)):
                m = re.match(r'(\d+)/\s*(\d+)', tok)
                if m:
                    cells[c]['dir'], cells[c]['spd'] = int(m.group(1)), int(m.group(2))
        elif 'DBZM' in ln and ids:
            for c, (dz, tp) in zip(ids, re.findall(r'(\d+)\s+(\d+\.\d+)', ln)):
                cells[c]['dbzm'], cells[c]['top'] = int(dz), float(tp)
    return cells


def build_storm_attr(station):
    if not _STATION_RE.match(station):
        raise ValueError('invalid station')
    key = fetch_latest_key(station, 'NST')
    if not key:
        raise ValueError(f'no recent storm-track (NST) data for {station}')
    raw = urllib.request.urlopen(
        urllib.request.Request(f"{L3_BUCKET}/{key}", headers={'User-Agent': 'FXNet-Proxy/1.0'}), timeout=25).read()
    pdb, rlat, rlon, buf = _pdb_and_buf(raw)
    prod_time = _read_prod_time(raw, pdb)

    # Symbology block (id 1): packet 15 carries each cell's ID + current centroid.
    ids = {}
    for bid, start, blen in _iter_blocks(buf):
        if bid != 1:
            continue
        layer_len = struct.unpack_from('>I', buf, start + 12)[0]
        off, end = start + 16, start + 16 + layer_len
        while off + 4 <= end and off + 4 <= len(buf):
            code = struct.unpack_from('>H', buf, off)[0]
            plen = struct.unpack_from('>H', buf, off + 2)[0]
            d = off + 4
            if code == 15 and plen >= 6:
                i, j = struct.unpack_from('>hh', buf, d)
                sid = buf[d + 4:d + 6].decode('ascii', 'replace').strip()
                if sid:
                    ids[sid] = (i, j)
            off = d + plen
        break

    # Graphic-alphanumeric block (id 2): the storm attribute table.
    attrs = {}
    for bid, start, blen in _iter_blocks(buf):
        if bid == 2:
            attrs = _parse_nst_table(buf[start:start + blen].decode('latin-1', 'replace'))
            break

    features = []
    for sid, (i, j) in ids.items():
        lon, lat = _ij_to_lonlat(i, j, rlat, rlon)
        a = attrs.get(sid, {})
        features.append({'type': 'Feature',
                         'properties': {'id': sid, 'kind': 'cell', 'dbzm': a.get('dbzm'),
                                        'top_kft': a.get('top'), 'mvt_dir': a.get('dir'),
                                        'mvt_spd': a.get('spd')},
                         'geometry': {'type': 'Point', 'coordinates': [lon, lat]}})
        # Forecast track: FCST MVT reports the direction the storm comes FROM, so it
        # moves toward dir+180 (validated against the product's own forecast points).
        if a.get('dir') is not None and a.get('spd'):
            toward = math.radians((a['dir'] + 180) % 360)
            track = [[lon, lat]]
            plat, plon = lat, lon
            for mins in (15, 30, 45, 60):
                km = a['spd'] * (mins / 60.0) * 1.852     # kt*hr -> nm -> km
                de, dn = km * math.sin(toward), km * math.cos(toward)
                track.append([lon + de / (111.32 * math.cos(math.radians(lat))), lat + dn / 111.32])
            features.append({'type': 'Feature', 'properties': {'id': sid, 'kind': 'forecast'},
                             'geometry': {'type': 'LineString', 'coordinates': track}})

    return {'success': True, 'type': 'geojson',
            'geojson': {'type': 'FeatureCollection', 'features': features},
            'meta': {'station': station, 'product': 'NST', 'name': 'Storm Tracks (STI)',
                     'time': prod_time, 'count': len(ids), 'key': key}}


def _parse_vad_table(text):
    """Parse the VAD Algorithm Output table -> [{alt_ft, dir, spd, rms}] (lowest-RMS per alt)."""
    out = {}
    for ln in re.findall(r'[ -~]{10,}', text):
        toks = ln.split()
        # Data row: ALT U V W DIR SPD RMS DIV SRNG ELEV (W/DIV may be 'NA'); a leading
        # page marker token may precede ALT, so anchor on the first 2-3 digit token.
        ai = next((k for k, t in enumerate(toks) if re.fullmatch(r'\d{2,3}', t)), None)
        if ai is None or ai + 6 >= len(toks):
            continue
        if not (re.fullmatch(r'\d{1,3}', toks[ai + 4]) and re.fullmatch(r'\d{1,3}', toks[ai + 5])):
            continue
        alt = int(toks[ai]) * 100
        direction, spd = int(toks[ai + 4]), int(toks[ai + 5])
        if not (0 <= direction <= 360 and 0 <= spd <= 300 and 500 <= alt <= 80000):
            continue
        try:
            rms = float(toks[ai + 6])
        except ValueError:
            rms = 99.0
        if alt not in out or rms < out[alt]['rms']:
            out[alt] = {'alt_ft': alt, 'dir': direction, 'spd': spd, 'rms': round(rms, 1)}
    return [out[a] for a in sorted(out)]


def build_vad(station):
    if not _STATION_RE.match(station):
        raise ValueError('invalid station')
    key = fetch_latest_key(station, 'NVW')
    if not key:
        raise ValueError(f'no recent VAD wind profile (NVW) for {station}')
    raw = urllib.request.urlopen(
        urllib.request.Request(f"{L3_BUCKET}/{key}", headers={'User-Agent': 'FXNet-Proxy/1.0'}), timeout=25).read()
    pdb, rlat, rlon, buf = _pdb_and_buf(raw)
    prod_time = _read_prod_time(raw, pdb)
    text = ''
    for bid, start, blen in _iter_blocks(buf):
        if bid == 3:
            text = buf[start:start + blen].decode('latin-1', 'replace')
            break
    profile = _parse_vad_table(text)
    return {'success': True, 'type': 'vad', 'profile': profile,
            'meta': {'station': station, 'product': 'NVW', 'name': 'VAD Wind Profile',
                     'time': prod_time, 'lat': rlat, 'lon': rlon, 'count': len(profile), 'key': key}}


def _azran_to_lonlat(az, ran_nm, rlat, rlon):
    """Project an azimuth (deg true) / range (nm) from the radar to lon/lat."""
    d_km = ran_nm * 1.852
    brg = math.radians(az)
    dn, de = d_km * math.cos(brg), d_km * math.sin(brg)
    return rlon + de / (111.32 * math.cos(math.radians(rlat))), rlat + dn / 111.32


# MDA table row, e.g. " 807  207/105  7  P7  34   54  <13   >20   70   13  34  N  312/ 28  2950"
# columns: CIRC-ID AZ/RAN SR STMID [LL-RV LL-DV BASE DEPTH STMREL% MAXRV-kft MAXRV-kts] TVS MOTION MSI
_MD_ROW = re.compile(
    r'\b(\d{1,4})\s+(\d{1,3})/\s*(\d{1,3})\s+(\d{1,2}[A-Z]?)\s+(\S{1,3})\s+(.*?)\s([YN])\s+(\d{1,3})/\s*(\d{1,3})\s+(\d+)\s*$')


def _parse_md_table(text):
    """Parse the Mesocyclone Detection Algorithm table -> list of circulation dicts."""
    out = []
    for ln in re.findall(r'[ -~]{20,}', text):
        m = _MD_ROW.search(ln)
        if not m:
            continue
        circ = {'id': m.group(1), 'az': int(m.group(2)), 'ran': int(m.group(3)),
                'sr': m.group(4), 'stmid': m.group(5), 'tvs': m.group(7),
                'mdir': int(m.group(8)), 'mspd': int(m.group(9)), 'msi': int(m.group(10))}
        # Detail columns (best-effort — format is fixed but values can be <n/>n):
        toks = m.group(6).split()
        if len(toks) >= 7:
            circ.update(llrv=toks[0], lldv=toks[1], base=toks[2], depth=toks[3],
                        strel=toks[4], maxrv_kft=toks[5], maxrv=toks[6])
        out.append(circ)
    return out


def build_meso(station):
    """Mesocyclone Detection (NMD, product 141): each detected circulation as a
    GeoJSON point with strength rank, TVS flag, rotational velocity and depth —
    the D2D meso/TVS marker overlay."""
    if not _STATION_RE.match(station):
        raise ValueError('invalid station')
    key = fetch_latest_key(station, 'NMD')
    if not key:
        raise ValueError(f'no recent mesocyclone (NMD) data for {station}')
    raw = urllib.request.urlopen(
        urllib.request.Request(f"{L3_BUCKET}/{key}", headers={'User-Agent': 'FXNet-Proxy/1.0'}), timeout=25).read()
    pdb, rlat, rlon, buf = _pdb_and_buf(raw)
    prod_time = _read_prod_time(raw, pdb)

    circs = []
    for bid, start, blen in _iter_blocks(buf):
        if bid == 3:
            circs = _parse_md_table(buf[start:start + blen].decode('latin-1', 'replace'))
            break

    features = []
    for c in circs:
        lon, lat = _azran_to_lonlat(c['az'], c['ran'], rlat, rlon)
        sr_n = int(re.sub(r'\D', '', c['sr']) or 0)
        features.append({'type': 'Feature',
                         'properties': {'id': c['id'], 'sr': c['sr'], 'sr_n': sr_n,
                                        'stmid': c['stmid'], 'tvs': c['tvs'],
                                        'llrv': c.get('llrv'), 'base': c.get('base'),
                                        'depth': c.get('depth'), 'maxrv': c.get('maxrv'),
                                        'mdir': c['mdir'], 'mspd': c['mspd'], 'msi': c['msi']},
                         'geometry': {'type': 'Point', 'coordinates': [lon, lat]}})

    return {'success': True, 'type': 'geojson',
            'geojson': {'type': 'FeatureCollection', 'features': features},
            'meta': {'station': station, 'product': 'NMD', 'name': 'Meso / TVS (MDA)',
                     'time': prod_time, 'count': len(features), 'key': key}}


# Storm-relative velocity is derived on the fly from the digital base velocity
# minus the mean storm-motion radial component read from the 0.5° product-56
# header (the only tilt product 56 is generated at — the motion vector itself is
# tilt-independent). SRM tilt pseudo-codes carry the same tilt character as the
# other digital products; each maps to the velocity products actually produced
# at that cut, best (super-res N?G) first. NBG (1.8° super-res) is rarely in
# the bucket, so tilt B falls to the conventional 2.4° cut (N2U). ~8x the data
# of the native 16-level SRM; sign match ~93% (validated against live MKX).
SRM_TILT_VEL = {
    '0': ('N0G',),
    'A': ('NAG',),
    '1': ('N1G', 'N1U'),
    'B': ('NBG', 'N2U'),
    '2': ('N2U', 'NBG'),   # legacy saved codes keep their real angle (2.4°)
    '3': ('N3U',),
}


def _is_srm(product):
    return len(product) == 3 and product[0] == 'N' and product[2] == 'S' and product[1] in SRM_TILT_VEL


def _fetch_key(station, product, offset=0):
    key = fetch_latest_key(station, product, offset)
    if not key:
        raise ValueError(f'no recent {product} data for {station}' + (f' (scan -{offset})' if offset else ''))
    req = urllib.request.Request(f"{L3_BUCKET}/{key}", headers={'User-Agent': 'FXNet-Proxy/1.0'})
    return urllib.request.urlopen(req, timeout=25).read(), key


def build_srm(station, product, offset=0):
    # Mean storm motion (tilt-independent) from the 0.5° product-56 header.
    # Always the latest — it barely drifts over a loop's worth of scans.
    sraw, _ = _fetch_key(station, 'N0S')
    sdec = decode_l3_v16(sraw, 'N0S')
    # Digital base velocity for the requested tilt — best available product.
    graw = gkey = velprod = None
    for cand in SRM_TILT_VEL.get(product[1], ('N0G',)):
        try:
            graw, gkey = _fetch_key(station, cand, offset)
            velprod = cand
            break
        except Exception:
            continue
    if graw is None:
        raise ValueError(f'SRM tilt {product[1]}: no velocity data in the current scan')
    gdec = decode_l3(graw, velprod)
    # SRM(az) = Vbase(az) - Vstorm·r̂(az) = Vbase - spd·cos(az - dir).
    off = sdec['storm_spd'] * np.cos(np.radians(gdec['az'] - sdec['storm_dir']))
    gdec['data'] = (gdec['data'] - off[:, None]).astype(np.float32)
    png, coords = render(gdec, velprod)
    meta = {
        'station': station, 'product': product, 'name': 'Storm Rel Velocity', 'units': 'kt',
        'elevation': gdec['el'], 'time': gdec['time'], 'max_range_km': gdec['max_range'],
        'storm_dir': sdec['storm_dir'], 'storm_spd': sdec['storm_spd'], 'key': gkey, 'hires': True,
    }
    return {
        'success': True,
        'image': 'data:image/png;base64,' + base64.b64encode(png).decode(),
        'coordinates': coords,
        'meta': meta,
    }


def build_radar(station, product, offset=0):
    if not _STATION_RE.match(station):
        raise ValueError('invalid station')
    if product not in CAL and product not in V16:
        raise ValueError(f'unsupported product {product}')
    # High-res storm-relative velocity, derived from base velocity. The native
    # 16-level SRM exists only at 0.5° (N0S), so that's the only tilt with a
    # fallback; other tilts surface a clear "not in this scan" error instead.
    if _is_srm(product):
        try:
            return build_srm(station, product, offset)
        except Exception as e:
            if product != 'N0S' or offset:
                raise ValueError(f'SRM tilt unavailable: {e}')
    key = fetch_latest_key(station, product, offset)
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
            try:
                offset = max(0, min(int(qs.get('offset', ['0'])[0]), 19))
            except ValueError:
                offset = 0
            if product in ('NST', 'STORMTRACK'):
                result = build_storm_attr(station)
            elif product in ('NVW', 'VAD'):
                result = build_vad(station)
            elif product in ('NMD', 'MESO'):
                result = build_meso(station)
            else:
                result = build_radar(station, product, offset)
            body = json.dumps(result).encode()
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
