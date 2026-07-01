from http.server import BaseHTTPRequestHandler
import urllib.request
import json

# Vercel function config — NWPS API can take 40-50s to respond
# maxDuration in seconds (Hobby: max 60, Pro: max 300)
config = {
    "maxDuration": 60
}

class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            url = 'https://api.water.noaa.gov/nwps/v1/gauges'
            req = urllib.request.Request(url, headers={
                'User-Agent': 'FXNet-NextGen/1.0',
                'Accept': 'application/json'
            })
            with urllib.request.urlopen(req, timeout=55) as response:
                data = json.loads(response.read())

            # Minify: extract only the fields needed for map display
            gauges = data.get('gauges', [])
            minimal = []
            for g in gauges:
                lat = g.get('latitude', 0)
                lon = g.get('longitude', 0)
                if not lat or not lon:
                    continue
                obs = g.get('status', {}).get('observed', {})
                fcst = g.get('status', {}).get('forecast', {})
                obs_cat = obs.get('floodCategory', '')
                fcst_cat = fcst.get('floodCategory', '')
                # Skip inactive/undefined gauges — cuts payload by ~40%
                if obs_cat in ('out_of_service', '', 'not_defined', 'obs_not_current'):
                    continue
                minimal.append({
                    'id': g.get('lid', ''),
                    'n': g.get('name', ''),
                    'la': round(lat, 4),
                    'lo': round(lon, 4),
                    'oc': obs_cat,
                    'fc': fcst_cat,
                    'os': obs.get('primary', -999),
                    'fs': fcst.get('primary', -999),
                    'ou': obs.get('primaryUnit', 'ft')
                })

            result = json.dumps(minimal, separators=(',', ':'))

            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            # NWPS takes 40-50s; let the Vercel CDN absorb repeat hits for 15 min.
            self.send_header('Cache-Control', 'public, max-age=300, s-maxage=900')
            self.end_headers()
            self.wfile.write(result.encode())
        except Exception as e:
            self.send_response(500)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({'error': str(e)}).encode())
