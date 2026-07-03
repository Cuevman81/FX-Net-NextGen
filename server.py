import http.server
import socketserver
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

class CustomHandler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split('?')[0]

        if path == '/api/metar':
            try:
                # Proxy the AWC request using explicit IDs to avoid bounding box limit failures
                icao_list = "KATL,KORD,KDFW,KDEN,KJFK,KLAX,KSEA,KSFO,KMIA,KPHX,KMSP,KDTW,KBOS,KPHL,KCLT,KSLC,KMCO,KIAD,KEWR,KMDW,KTPA,KPDX,KHOU,KDAL,KSJC,KSTL,KBWI,KMSY,KMEM,KCLE,KIND,KAUS,KSAT,KRDU,KCVG,KSDF,KPIT,KMKE,KBUF,KOMA,KOKC,KRIC,KHNL,PANC,KABQ,KCHS,KCMH,KRSW,KBDL,KBOI,KBUR,KPVD,KPBI,KORF,KMYR,KSRQ,KILM,KTLH,KJAX,KPNS,KVPS,KMOB,KBHM,KBNA,KHSV,KLIT,KJAN,KGPT,KLFT,KXNA,KBTR,KSHV,KSFB,KEYW,KMLB,KPGD,KAPF,KPIE,KGNV,KCRG,KECP,KVLD,KDAB,KSAV,KDHN,KCSG,KABY,KAGS,KVQQ,KSSI,KCAE,KFLO,KOAJ,KPHF,KCHO,KROA,KLYH,KCRW,KBLF,KHTS,KPKB,KCKB,KBKW,KEKN,KMGW,KHLG,KLWB,KSHD,KOKV,KFRR,KCJR,KHWY,KMTN,KDCA,KILG,KDOV,KTTN,KACY,KBLM,KMIV,KWRI,KVAY,KCDW,KSMQ,KTEB,KMMU,KFWN,KLDJ,KDYL,KPTW,KUKT,KLOM,KMQS,KPNE,KCKZ,KABE,KRDG,KBCB,KPSK,KVJI,KTNB,KGEV,KGKT,KDKK,KMEV,KSYP,KSKF,KEDC,KHYI,KGTU,KBAZ,KRBD,KSSF,KCVB,KERV,KPEZ,KSZT,KCOE,KPBF,KPEQ,KDSM,KCID,KDBQ,KSUX,KMLI,KPIA,KSPI,KCMI,KBMG,KLAF,KFWA,KSBN,KGRR,KLAN,KFNT,KMBS,KTVC,KPLN,KAPN,KMQT,KIMT,KGRB,KATW,KCWA,KEAU,KLSE,KRST,KDLH,KBRD,KSTC,KFAR,KGFK,KBIS,KMOT,KDIK,KJMS,KABR,KPIR,KRAP,KFSD,KSUA,KVTN,KLBF,KGRI,KMCK,KGLD,KHYS,KSLN,KGBD,KDDC,KGCK,KHUT,KICT,KTOP,KMHK,KLNK,KCNU,KJLN,KSGF,KCGI,KPAH,KEVV,KOWB,KLEX,KGEG,KPUW,KALW,KPSC,KYKM,KEAT,KMWH,KOLM,KHQM,KUIL,KAST,KTMK,KSLE,KEUG,KOTH,KACV,KCEC,KRDD,KCIC,KSMF,KSCK,KMOD,KMER,KFAT,KVIS,KBFL,KPMD,KWJF,KNID,KTRM,KIPL,KNYL,KPRC,KFLG,KINW,KSAW,KPGA,KGCN,KSGE,KCGZ,KDUG,KTUS,KFHU,KSAD,KOLS,KALS,KDRO,KTEX,KMTJ,KGJT,KRIL,KEGE,KASE,KSBS,KHDN,KCAG,KCPR,KGCC,KSHR,KCOD"
                req = urllib.request.Request(f"https://aviationweather.gov/api/data/metar?format=geojson&ids={icao_list}")
                req.add_header('User-Agent', 'FXNet-LocalProxy/1.0')
                with safe_urlopen(req, timeout=15) as response:
                    data = response.read()
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/json')
                    self.end_headers()
                    self.wfile.write(data)
            except Exception as e:
                self.send_response(500)
                self.end_headers()
                self.wfile.write(json.dumps({'type': 'FeatureCollection', 'features': [], 'error': str(e)}).encode())

        elif path == '/api/airsigmet':
            try:
                req = urllib.request.Request('https://aviationweather.gov/api/data/airsigmet?format=geojson')
                req.add_header('User-Agent', 'FXNet-LocalProxy/1.0')
                with safe_urlopen(req, timeout=15) as response:
                    data = response.read()
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/json')
                    self.send_header('Access-Control-Allow-Origin', '*')
                    self.end_headers()
                    self.wfile.write(data)
            except Exception as e:
                self.send_response(500)
                self.end_headers()
                self.wfile.write(json.dumps({'type': 'FeatureCollection', 'features': [], 'error': str(e)}).encode())

        elif path == '/api/pirep':
            try:
                req = urllib.request.Request('https://aviationweather.gov/api/data/pirep?format=geojson&age=3&bbox=20,-130,55,-60')
                req.add_header('User-Agent', 'FXNet-LocalProxy/1.0')
                with safe_urlopen(req, timeout=15) as response:
                    data = response.read()
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/json')
                    self.send_header('Access-Control-Allow-Origin', '*')
                    self.end_headers()
                    self.wfile.write(data)
            except Exception as e:
                self.send_response(500)
                self.end_headers()
                self.wfile.write(json.dumps({'type': 'FeatureCollection', 'features': [], 'error': str(e)}).encode())

        elif path == '/api/taf':
            try:
                req = urllib.request.Request('https://aviationweather.gov/api/data/taf?format=geojson&bbox=20,-130,55,-60')
                req.add_header('User-Agent', 'FXNet-LocalProxy/1.0')
                with safe_urlopen(req, timeout=15) as response:
                    data = response.read()
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/json')
                    self.send_header('Access-Control-Allow-Origin', '*')
                    self.end_headers()
                    self.wfile.write(data)
            except Exception as e:
                self.send_response(500)
                self.end_headers()
                self.wfile.write(json.dumps({'type': 'FeatureCollection', 'features': [], 'error': str(e)}).encode())

        elif path == '/api/gairmet':
            try:
                req = urllib.request.Request('https://aviationweather.gov/api/data/gairmet?format=geojson')
                req.add_header('User-Agent', 'FXNet-LocalProxy/1.0')
                with safe_urlopen(req, timeout=15) as response:
                    data = response.read()
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/json')
                    self.send_header('Access-Control-Allow-Origin', '*')
                    self.end_headers()
                    self.wfile.write(data)
            except Exception as e:
                self.send_response(500)
                self.end_headers()
                self.wfile.write(json.dumps({'type': 'FeatureCollection', 'features': [], 'error': str(e)}).encode())

        elif path == '/api/raob':
            try:
                from urllib.parse import urlparse, parse_qs, quote
                q = parse_qs(urlparse(self.path).query)
                station = (q.get('station', [''])[0] or '').upper()
                wmo = q.get('wmo', [''])[0]
                ts = q.get('ts', [''])[0]
                dt = ts.replace('T', ' ').replace('Z', '')
                result = None
                if wmo:
                    try:
                        wurl = f"https://weather.uwyo.edu/wsgi/sounding?datetime={quote(dt)}&id={wmo}&type=TEXT:LIST&src=UNKNOWN"
                        wreq = urllib.request.Request(wurl, headers={'User-Agent': 'Mozilla/5.0 (FXNet-Proxy)'})
                        with safe_urlopen(wreq, timeout=22) as wr:
                            wraw = wr.read().decode('utf-8', 'replace')
                        m = re.search(r'<PRE>(.*?)</PRE>', wraw, re.S)
                        if m:
                            def _num(s):
                                s = s.strip()
                                return None if s in ('', '-', '----', '/////') else float(s)
                            prof = []
                            for ln in m.group(1).splitlines():
                                if not re.match(r'^\s*-?\d', ln):
                                    continue
                                try:
                                    pres = _num(ln[0:7]); tmpc = _num(ln[14:21])
                                    if pres is None or tmpc is None:
                                        continue
                                    sped = _num(ln[49:56])
                                    prof.append({'pres': pres, 'hght': _num(ln[7:14]), 'tmpc': tmpc,
                                                 'dwpc': _num(ln[21:28]), 'drct': _num(ln[42:49]),
                                                 'sknt': (sped * 1.94384 if sped is not None else None)})
                                except (ValueError, IndexError):
                                    continue
                            if len(prof) > 10:
                                result = {'success': True, 'source': 'wyoming', 'station': station, 'valid': dt + 'Z', 'profile': prof}
                    except Exception:
                        result = None
                if result is None:
                    ireq = urllib.request.Request(f"https://mesonet.agron.iastate.edu/json/raob.py?ts={ts}&station={station}", headers={'User-Agent': 'FXNet-LocalProxy/1.0'})
                    with safe_urlopen(ireq, timeout=22) as ir:
                        j = json.loads(ir.read())
                    profs = j.get('profiles') or []
                    if profs and profs[0].get('profile'):
                        result = {'success': True, 'source': 'iem', 'station': station, 'valid': profs[0].get('valid'), 'profile': profs[0]['profile']}
                    else:
                        result = {'success': False, 'error': 'no sounding data for that station/time', 'profile': []}
                self.send_response(200 if result.get('success') else 404)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(json.dumps(result).encode())
            except Exception as e:
                self.send_response(502)
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(json.dumps({'success': False, 'error': str(e), 'profile': []}).encode())

        elif path == '/api/probsevere':
            try:
                import re as _re
                base = 'https://mrms.ncep.noaa.gov/data/ProbSevere/PROBSEVERE/'
                lreq = urllib.request.Request(base, headers={'User-Agent': 'FXNet-LocalProxy/1.0'})
                with safe_urlopen(lreq, timeout=15) as lr:
                    listing = lr.read().decode('utf-8', 'replace')
                names = _re.findall(r'MRMS_PROBSEVERE_\d{8}_\d{6}\.json', listing)
                if not names:
                    raise ValueError('no ProbSevere files found')
                newest = sorted(set(names))[-1]
                freq = urllib.request.Request(base + newest, headers={'User-Agent': 'FXNet-LocalProxy/1.0'})
                with safe_urlopen(freq, timeout=15) as fr:
                    data = fr.read()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(data)
            except Exception as e:
                self.send_response(502)
                self.end_headers()
                self.wfile.write(json.dumps({'type': 'FeatureCollection', 'features': [], 'error': str(e)}).encode())

        elif path == '/api/wpc-isobars':
            try:
                req = urllib.request.Request('https://ftp-wpc.ncep.noaa.gov/sfcanl_isobars/isobars_latest.txt')
                req.add_header('User-Agent', 'FXNet-LocalProxy/1.0')
                with safe_urlopen(req, timeout=15) as response:
                    data = response.read()
                    self.send_response(200)
                    self.send_header('Content-Type', 'text/plain')
                    self.send_header('Access-Control-Allow-Origin', '*')
                    self.end_headers()
                    self.wfile.write(data)
            except Exception as e:
                self.send_response(500)
                self.end_headers()
                self.wfile.write(f'ERROR: {str(e)}'.encode())

        elif path == '/api/wpc-coded-fronts':
            try:
                req = urllib.request.Request('https://www.wpc.ncep.noaa.gov/discussions/codsus')
                req.add_header('User-Agent', 'FXNet-LocalProxy/1.0')
                with safe_urlopen(req, timeout=15) as response:
                    data = response.read()
                    self.send_response(200)
                    self.send_header('Content-Type', 'text/plain')
                    self.send_header('Access-Control-Allow-Origin', '*')
                    self.end_headers()
                    self.wfile.write(data)
            except Exception as e:
                self.send_response(500)
                self.end_headers()
                self.wfile.write(f'ERROR: {str(e)}'.encode())

        elif path == '/api/wpc-ero-discussion':
            try:
                req = urllib.request.Request('https://www.wpc.ncep.noaa.gov/discussions/hpcdiscussions.php?disc=qpferd')
                req.add_header('User-Agent', 'FXNet-LocalProxy/1.0')
                with safe_urlopen(req, timeout=15) as response:
                    data = response.read()
                    self.send_response(200)
                    self.send_header('Content-Type', 'text/html')
                    self.send_header('Access-Control-Allow-Origin', '*')
                    self.end_headers()
                    self.wfile.write(data)
            except Exception as e:
                self.send_response(500)
                self.end_headers()
                self.wfile.write(f'ERROR: {str(e)}'.encode())

        elif path == '/api/nhc-two-atl':
            try:
                req = urllib.request.Request('https://www.nhc.noaa.gov/text/MIATWOAT.shtml')
                req.add_header('User-Agent', 'FXNet-LocalProxy/1.0')
                with safe_urlopen(req, timeout=15) as response:
                    data = response.read()
                    self.send_response(200)
                    self.send_header('Content-Type', 'text/html')
                    self.send_header('Access-Control-Allow-Origin', '*')
                    self.end_headers()
                    self.wfile.write(data)
            except Exception as e:
                self.send_response(500)
                self.end_headers()
                self.wfile.write(f'ERROR: {str(e)}'.encode())

        elif path == '/api/nhc-two-epac':
            try:
                req = urllib.request.Request('https://www.nhc.noaa.gov/text/MIATWOEP.shtml')
                req.add_header('User-Agent', 'FXNet-LocalProxy/1.0')
                with safe_urlopen(req, timeout=15) as response:
                    data = response.read()
                    self.send_response(200)
                    self.send_header('Content-Type', 'text/html')
                    self.send_header('Access-Control-Allow-Origin', '*')
                    self.end_headers()
                    self.wfile.write(data)
            except Exception as e:
                self.send_response(500)
                self.end_headers()
                self.wfile.write(f'ERROR: {str(e)}'.encode())

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

                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(data)
            except Exception as e:
                self.send_response(500)
                self.end_headers()
                self.wfile.write(json.dumps({'error': str(e)}).encode())

        elif path == '/api/wpc-ero':
            # WPC Excessive Rainfall Outlook (KMZ -> GeoJSON). Reuse the Vercel
            # function's converter so local and prod behavior stay identical.
            try:
                from urllib.parse import urlparse, parse_qs
                import importlib.util
                qs = parse_qs(urlparse(self.path).query)
                day = qs.get('day', ['1'])[0]
                spec = importlib.util.spec_from_file_location(
                    'wpc_ero', os.path.join(os.path.dirname(__file__), 'api', 'wpc-ero.py'))
                ero_mod = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(ero_mod)
                if day not in ero_mod.ERO_KMZ:
                    day = '1'
                geojson = ero_mod.kmz_to_geojson(day)
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(json.dumps(geojson).encode())
            except Exception as e:
                self.send_response(500)
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(json.dumps({'error': str(e)}).encode())

        elif path == '/api/spc-fire-wx':
            # SPC Fire Weather Outlook (KMZ -> GeoJSON). Reuse the Vercel
            # function's converter so local and prod behavior stay identical.
            try:
                from urllib.parse import urlparse, parse_qs
                import importlib.util
                qs = parse_qs(urlparse(self.path).query)
                day = qs.get('day', ['1'])[0]
                spec = importlib.util.spec_from_file_location(
                    'spc_fire_wx', os.path.join(os.path.dirname(__file__), 'api', 'spc-fire-wx.py'))
                fw_mod = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(fw_mod)
                if day not in fw_mod.FIREWX_KMZ:
                    day = '1'
                geojson = fw_mod.kmz_to_geojson(day)
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(json.dumps(geojson).encode())
            except Exception as e:
                self.send_response(500)
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(json.dumps({'error': str(e)}).encode())

        elif path == '/api/radar-l3':
            # NEXRAD Level III (NODD) -> transparent georeferenced radar overlay.
            # Reuse the Vercel function's decode/render so local/prod stay identical.
            try:
                from urllib.parse import urlparse, parse_qs
                import importlib.util
                qs = parse_qs(urlparse(self.path).query)
                station = qs.get('station', ['KDGX'])[0].upper()
                product = qs.get('product', ['N0B'])[0].upper()
                spec = importlib.util.spec_from_file_location(
                    'radar_l3', os.path.join(os.path.dirname(__file__), 'api', 'radar-l3.py'))
                rl3 = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(rl3)
                if product in ('NST', 'STORMTRACK'):
                    result = rl3.build_storm_attr(station)
                elif product in ('NVW', 'VAD'):
                    result = rl3.build_vad(station)
                else:
                    result = rl3.build_radar(station, product)
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(json.dumps(result).encode())
            except Exception as e:
                self.send_response(500)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(json.dumps({'success': False, 'error': str(e)}).encode())

        elif path == '/api/gibs-times':
            try:
                from urllib.parse import urlparse, parse_qs
                import importlib.util
                qs = parse_qs(urlparse(self.path).query)
                layer = qs.get('layer', ['GOES-East_ABI_GeoColor'])[0]
                tms = qs.get('tms', ['GoogleMapsCompatible_Level7'])[0]
                n = max(1, min(int(qs.get('n', ['30'])[0]), 60))
                spec = importlib.util.spec_from_file_location(
                    'gibs_times', os.path.join(os.path.dirname(__file__), 'api', 'gibs-times.py'))
                gt = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(gt)
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(json.dumps({'times': gt.recent_times(layer, tms, n)}).encode())
            except Exception as e:
                self.send_response(500)
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(json.dumps({'error': str(e), 'times': []}).encode())

        elif path == '/api/wpc-mpd':
            # WPC Mesoscale Precipitation Discussions (IEM shapefile -> active GeoJSON).
            # Reuse the Vercel function's converter so local/prod stay identical.
            try:
                import importlib.util
                spec = importlib.util.spec_from_file_location(
                    'wpc_mpd', os.path.join(os.path.dirname(__file__), 'api', 'wpc-mpd.py'))
                mpd_mod = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(mpd_mod)
                geojson = mpd_mod.fetch_active_mpds()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(json.dumps(geojson).encode())
            except Exception as e:
                self.send_response(500)
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(json.dumps({'error': str(e)}).encode())

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

with socketserver.TCPServer(("", PORT), CustomHandler) as httpd:
    print(f"Serving at http://localhost:{PORT}")
    print(f"Ready to receive logs directly to {LOG_FILE}")
    print("Proxying AWC METARs on /api/metar to bypass CORS")
    httpd.serve_forever()
