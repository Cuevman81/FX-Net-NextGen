from http.server import BaseHTTPRequestHandler
import urllib.request

class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            req = urllib.request.Request(
                'https://www.nhc.noaa.gov/text/MIATWOAT.shtml',
                headers={'User-Agent': 'FXNet-VercelProxy/1.0'}
            )
            with urllib.request.urlopen(req, timeout=15) as response:
                data = response.read()

            self.send_response(200)
            self.send_header('Content-Type', 'text/html')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Cache-Control', 'public, max-age=900')
            self.end_headers()
            self.wfile.write(data)
        except Exception as e:
            self.send_response(500)
            self.send_header('Content-Type', 'text/plain')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(str(e).encode())
