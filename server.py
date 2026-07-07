import http.server
import socketserver
import importlib.util
import os
import re
import urllib.request
import urllib.error
import json
from urllib.parse import urlparse, parse_qs, quote

PORT = 8888
LOG_FILE = "fxnet_diagnostic_log.txt"

def safe_urlopen(req, timeout=15):
    # TLS certificates are verified (Python's default). If this ever fails with
    # SSLCertVerificationError on a fresh macOS Python, install its root certs:
    #   /Applications/Python 3.x/Install Certificates.command
    return urllib.request.urlopen(req, timeout=timeout)


def load_api(filename, modname):
    """Load a Vercel function module from api/ so local and prod share one
    implementation (the api/ filenames contain '-', so no plain import)."""
    spec = importlib.util.spec_from_file_location(
        modname, os.path.join(os.path.dirname(__file__), 'api', filename))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# Explicit METAR station ids to avoid AWC bounding-box limit failures.
METAR_IDS = "KATL,KORD,KDFW,KDEN,KJFK,KLAX,KSEA,KSFO,KMIA,KPHX,KMSP,KDTW,KBOS,KPHL,KCLT,KSLC,KMCO,KIAD,KEWR,KMDW,KTPA,KPDX,KHOU,KDAL,KSJC,KSTL,KBWI,KMSY,KMEM,KCLE,KIND,KAUS,KSAT,KRDU,KCVG,KSDF,KPIT,KMKE,KBUF,KOMA,KOKC,KRIC,KHNL,PANC,KABQ,KCHS,KCMH,KRSW,KBDL,KBOI,KBUR,KPVD,KPBI,KORF,KMYR,KSRQ,KILM,KTLH,KJAX,KPNS,KVPS,KMOB,KBHM,KBNA,KHSV,KLIT,KJAN,KGPT,KLFT,KXNA,KBTR,KSHV,KSFB,KEYW,KMLB,KPGD,KAPF,KPIE,KGNV,KCRG,KECP,KVLD,KDAB,KSAV,KDHN,KCSG,KABY,KAGS,KVQQ,KSSI,KCAE,KFLO,KOAJ,KPHF,KCHO,KROA,KLYH,KCRW,KBLF,KHTS,KPKB,KCKB,KBKW,KEKN,KMGW,KHLG,KLWB,KSHD,KOKV,KFRR,KCJR,KHWY,KMTN,KDCA,KILG,KDOV,KTTN,KACY,KBLM,KMIV,KWRI,KVAY,KCDW,KSMQ,KTEB,KMMU,KFWN,KLDJ,KDYL,KPTW,KUKT,KLOM,KMQS,KPNE,KCKZ,KABE,KRDG,KBCB,KPSK,KVJI,KTNB,KGEV,KGKT,KDKK,KMEV,KSYP,KSKF,KEDC,KHYI,KGTU,KBAZ,KRBD,KSSF,KCVB,KERV,KPEZ,KSZT,KCOE,KPBF,KPEQ,KDSM,KCID,KDBQ,KSUX,KMLI,KPIA,KSPI,KCMI,KBMG,KLAF,KFWA,KSBN,KGRR,KLAN,KFNT,KMBS,KTVC,KPLN,KAPN,KMQT,KIMT,KGRB,KATW,KCWA,KEAU,KLSE,KRST,KDLH,KBRD,KSTC,KFAR,KGFK,KBIS,KMOT,KDIK,KJMS,KABR,KPIR,KRAP,KFSD,KSUA,KVTN,KLBF,KGRI,KMCK,KGLD,KHYS,KSLN,KGBD,KDDC,KGCK,KHUT,KICT,KTOP,KMHK,KLNK,KCNU,KJLN,KSGF,KCGI,KPAH,KEVV,KOWB,KLEX,KGEG,KPUW,KALW,KPSC,KYKM,KEAT,KMWH,KOLM,KHQM,KUIL,KAST,KTMK,KSLE,KEUG,KOTH,KACV,KCEC,KRDD,KCIC,KSMF,KSCK,KMOD,KMER,KFAT,KVIS,KBFL,KPMD,KWJF,KNID,KTRM,KIPL,KNYL,KPRC,KFLG,KINW,KSAW,KPGA,KGCN,KSGE,KCGZ,KDUG,KTUS,KFHU,KSAD,KOLS,KALS,KDRO,KTEX,KMTJ,KGJT,KRIL,KEGE,KASE,KSBS,KHDN,KCAG,KCPR,KGCC,KSHR,KCOD"

# Simple pass-through CORS proxies: path -> (upstream URL, response content-type).
# One handler serves them all; JSON routes fall back to an empty FeatureCollection
# on error, text/html routes to an ERROR string.
SIMPLE_PROXIES = {
    '/api/metar':              (f"https://aviationweather.gov/api/data/metar?format=geojson&ids={METAR_IDS}", 'application/json'),
    '/api/airsigmet':          ('https://aviationweather.gov/api/data/airsigmet?format=geojson', 'application/json'),
    '/api/pirep':              ('https://aviationweather.gov/api/data/pirep?format=geojson&age=3&bbox=20,-130,55,-60', 'application/json'),
    '/api/taf':                ('https://aviationweather.gov/api/data/taf?format=geojson&bbox=20,-130,55,-60', 'application/json'),
    '/api/gairmet':            ('https://aviationweather.gov/api/data/gairmet?format=geojson', 'application/json'),
    '/api/cwa':                ('https://aviationweather.gov/api/data/cwa?format=geojson', 'application/json'),
    '/api/ndbc':               ('https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt', 'text/plain'),
    '/api/wpc-isobars':        ('https://ftp-wpc.ncep.noaa.gov/sfcanl_isobars/isobars_latest.txt', 'text/plain'),
    '/api/wpc-coded-fronts':   ('https://www.wpc.ncep.noaa.gov/discussions/codsus', 'text/plain'),
    '/api/wpc-ero-discussion': ('https://www.wpc.ncep.noaa.gov/discussions/hpcdiscussions.php?disc=qpferd', 'text/html'),
    '/api/nhc-two-atl':        ('https://www.nhc.noaa.gov/text/MIATWOAT.shtml', 'text/html'),
    '/api/nhc-two-epac':       ('https://www.nhc.noaa.gov/text/MIATWOEP.shtml', 'text/html'),
}


class CustomHandler(http.server.SimpleHTTPRequestHandler):
    def _send(self, status, ctype, body):
        self.send_response(status)
        self.send_header('Content-Type', ctype)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, obj, status=200):
        self._send(status, 'application/json', json.dumps(obj).encode())

    def do_GET(self):
        path = self.path.split('?')[0]

        if path in SIMPLE_PROXIES:
            url, ctype = SIMPLE_PROXIES[path]
            try:
                req = urllib.request.Request(url, headers={'User-Agent': 'FXNet-LocalProxy/1.0'})
                with safe_urlopen(req, timeout=15) as response:
                    self._send(200, ctype, response.read())
            except Exception as e:
                if ctype == 'application/json':
                    self._send_json({'type': 'FeatureCollection', 'features': [], 'error': str(e)}, 500)
                else:
                    self._send(500, ctype, f'ERROR: {str(e)}'.encode())

        elif path == '/api/raob':
            # Reuse the Vercel function (validation + Wyoming/IEM logic live there).
            try:
                q = parse_qs(urlparse(self.path).query)
                station = (q.get('station', [''])[0] or '').upper()
                wmo = q.get('wmo', [''])[0]
                ts = q.get('ts', [''])[0]
                if not station or not ts:
                    raise ValueError('station and ts are required')
                raob = load_api('raob.py', 'raob')
                result = raob.get_raob(wmo, station, ts)
                self._send_json(result, 200 if result.get('success') else 404)
            except Exception as e:
                self._send_json({'success': False, 'error': str(e), 'profile': []}, 502)

        elif path == '/api/probsevere':
            # Reuse the Vercel function (newest-file discovery + property trim).
            try:
                ps = load_api('probsevere.py', 'probsevere')
                self._send_json(ps.latest_probsevere())
            except Exception as e:
                self._send_json({'type': 'FeatureCollection', 'features': [], 'error': str(e)}, 502)

        elif path == '/api/drought-monitor':
            try:
                import datetime
                today = datetime.date.today()
                days_since_tues = (today.weekday() - 1) % 7
                last_tuesday = today - datetime.timedelta(days=days_since_tues)
                date_str = last_tuesday.strftime('%Y%m%d')
                url = f'https://droughtmonitor.unl.edu/data/json/usdm_{date_str}.json'

                req = urllib.request.Request(url)
                req.add_header('User-Agent', 'FXNet-LocalProxy/1.0')
                try:
                    with safe_urlopen(req, timeout=15) as response:
                        data = response.read()
                except urllib.error.HTTPError as he:
                    if he.code == 404:
                        # Fallback to the previous week's Tuesday if this week's Tuesday has not been published yet
                        prev_tuesday = last_tuesday - datetime.timedelta(days=7)
                        date_str = prev_tuesday.strftime('%Y%m%d')
                        url = f'https://droughtmonitor.unl.edu/data/json/usdm_{date_str}.json'
                        req = urllib.request.Request(url)
                        req.add_header('User-Agent', 'FXNet-LocalProxy/1.0')
                        with safe_urlopen(req, timeout=15) as response:
                            data = response.read()
                    else:
                        raise he
                self._send(200, 'application/json', data)
            except Exception as e:
                self._send_json({'error': str(e)}, 500)

        elif path == '/api/wpc-ero':
            # WPC Excessive Rainfall Outlook (KMZ -> GeoJSON), via the Vercel converter.
            try:
                qs = parse_qs(urlparse(self.path).query)
                day = qs.get('day', ['1'])[0]
                ero_mod = load_api('wpc-ero.py', 'wpc_ero')
                if day not in ero_mod.ERO_KMZ:
                    day = '1'
                self._send_json(ero_mod.kmz_to_geojson(day))
            except Exception as e:
                self._send_json({'error': str(e)}, 500)

        elif path == '/api/spc-fire-wx':
            # SPC Fire Weather Outlook (KMZ -> GeoJSON), via the Vercel converter.
            try:
                qs = parse_qs(urlparse(self.path).query)
                day = qs.get('day', ['1'])[0]
                fw_mod = load_api('spc-fire-wx.py', 'spc_fire_wx')
                if day not in fw_mod.FIREWX_KMZ:
                    day = '1'
                self._send_json(fw_mod.kmz_to_geojson(day))
            except Exception as e:
                self._send_json({'error': str(e)}, 500)

        elif path == '/api/radar-l3':
            # NEXRAD Level III (NODD) -> radar overlay / storm tracks / VAD / meso,
            # via the Vercel decoder so local and prod stay identical.
            try:
                qs = parse_qs(urlparse(self.path).query)
                station = qs.get('station', ['KDGX'])[0].upper()
                product = qs.get('product', ['N0B'])[0].upper()
                try:
                    offset = max(0, min(int(qs.get('offset', ['0'])[0]), 19))
                except ValueError:
                    offset = 0
                rl3 = load_api('radar-l3.py', 'radar_l3')
                if product in ('NST', 'STORMTRACK'):
                    result = rl3.build_storm_attr(station)
                elif product in ('NVW', 'VAD'):
                    result = rl3.build_vad(station)
                elif product in ('NMD', 'MESO'):
                    result = rl3.build_meso(station)
                else:
                    result = rl3.build_radar(station, product, offset)
                self._send_json(result)
            except Exception as e:
                self._send_json({'success': False, 'error': str(e)}, 500)

        elif path == '/api/gibs-times':
            try:
                qs = parse_qs(urlparse(self.path).query)
                layer = qs.get('layer', ['GOES-East_ABI_GeoColor'])[0]
                tms = qs.get('tms', ['GoogleMapsCompatible_Level7'])[0]
                n = max(1, min(int(qs.get('n', ['30'])[0]), 60))
                gt = load_api('gibs-times.py', 'gibs_times')
                self._send_json({'times': gt.recent_times(layer, tms, n)})
            except Exception as e:
                self._send_json({'error': str(e), 'times': []}, 500)

        elif path == '/api/wpc-mpd':
            # WPC Mesoscale Precipitation Discussions, via the Vercel converter.
            try:
                mpd_mod = load_api('wpc-mpd.py', 'wpc_mpd')
                self._send_json(mpd_mod.fetch_active_mpds())
            except Exception as e:
                self._send_json({'error': str(e)}, 500)

        else:
            # Fallback to serving regular static files
            super().do_GET()

    def do_POST(self):
        if self.path == '/log':
            content_length = min(int(self.headers.get('Content-Length', 0) or 0), 64 * 1024)
            post_data = self.rfile.read(content_length) if content_length > 0 else b''

            # Append log entry to the file
            with open(LOG_FILE, 'a') as f:
                f.write(post_data.decode('utf-8', errors='replace') + '\n')

            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'Log saved')
        else:
            self.send_response(404)
            self.end_headers()

# Clear the old log file on server start
if os.path.exists(LOG_FILE):
    open(LOG_FILE, 'w').close()

# Allow address reuse so server restarts quickly
socketserver.TCPServer.allow_reuse_address = True

# Bind loopback only — this is a dev server; don't expose the proxies or the
# /log endpoint to the rest of the LAN.
with socketserver.TCPServer(("127.0.0.1", PORT), CustomHandler) as httpd:
    print(f"Serving at http://localhost:{PORT}")
    print(f"Ready to receive logs directly to {LOG_FILE}")
    print("Proxying NOAA/AWC/NDBC feeds on /api/* to bypass CORS")
    httpd.serve_forever()
