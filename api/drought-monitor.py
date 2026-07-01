from http.server import BaseHTTPRequestHandler
import urllib.request
import urllib.error
import datetime
import json

class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            today = datetime.date.today()
            days_since_tues = (today.weekday() - 1) % 7
            last_tuesday = today - datetime.timedelta(days=days_since_tues)
            date_str = last_tuesday.strftime('%Y%m%d')
            url = f'https://droughtmonitor.unl.edu/data/json/usdm_{date_str}.json'
            
            req = urllib.request.Request(url, headers={'User-Agent': 'FXNet-VercelProxy/1.0'})
            try:
                with urllib.request.urlopen(req, timeout=15) as response:
                    data = response.read()
            except urllib.error.HTTPError as he:
                if he.code == 404:
                    # Fallback to the previous week's Tuesday if this week's Tuesday has not been published yet
                    prev_tuesday = last_tuesday - datetime.timedelta(days=7)
                    date_str = prev_tuesday.strftime('%Y%m%d')
                    url = f'https://droughtmonitor.unl.edu/data/json/usdm_{date_str}.json'
                    req = urllib.request.Request(url, headers={'User-Agent': 'FXNet-VercelProxy/1.0'})
                    with urllib.request.urlopen(req, timeout=15) as response:
                        data = response.read()
                else:
                    raise he

            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            # USDM updates weekly (Thursdays); cache aggressively.
            self.send_header('Cache-Control', 'public, max-age=3600, s-maxage=21600')
            self.end_headers()
            self.wfile.write(data)
        except Exception as e:
            self.send_response(500)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({'error': str(e)}).encode())
