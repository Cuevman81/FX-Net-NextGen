"""Single entrypoint for every stdlib-only feed.

Vercel builds one function bundle per file in api/, and the Python runtime
installs the root requirements.txt into every one of them with no
tree-shaking. Only radar-l3.py imports numpy and Pillow, so eight separate
bundles were each carrying ~45 MB of numerical libraries they never called.

Routing all eight through this one file collapses those bundles into one.
The feed modules are unchanged and still own their own parsing, caching and
error handling; they live beside this file with a leading underscore, which
is how Vercel is told not to turn them into routes of their own.

vercel.json rewrites the public paths here, e.g.
    /api/wpc-mpd?x=1  ->  /api/proxy?__fn=wpc-mpd&x=1
so the URLs the frontend calls do not change.
"""

from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
import importlib
import json
import os
import sys
import traceback

# The bundle layout puts these beside us; make that importable regardless of
# how the runtime sets up sys.path.
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

# public route name -> sibling module
FEEDS = {
    'adeck':           '_adeck',
    'drought-monitor': '_drought_monitor',
    'gibs-times':      '_gibs_times',
    'probsevere':      '_probsevere',
    'raob':            '_raob',
    'spc-fire-wx':     '_spc_fire_wx',
    'wpc-ero':         '_wpc_ero',
    'wpc-mpd':         '_wpc_mpd',
}

_loaded = {}


def _load(name):
    """Import a feed module on first use so a cold start only pays for the
    one feed being asked for, not all eight."""
    mod = _loaded.get(name)
    if mod is None:
        mod = importlib.import_module(FEEDS[name])
        _loaded[name] = mod
    return mod


class handler(BaseHTTPRequestHandler):
    def _resolve(self):
        qs = parse_qs(urlparse(self.path).query)
        name = (qs.get('__fn') or [''])[0]
        return name if name in FEEDS else None

    def _fail(self, code, message):
        body = json.dumps({'error': message}).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def _dispatch(self, method):
        name = self._resolve()
        if name is None:
            # Unknown or missing __fn: the rewrite table and this map disagree.
            self._fail(404, 'unknown feed')
            return
        try:
            target = _load(name)
        except Exception:
            # An import error is ours, not the upstream's — log it, stay quiet.
            traceback.print_exc()
            self._fail(500, 'feed unavailable')
            return
        # The feed handlers are BaseHTTPRequestHandler subclasses that only
        # touch self.path / send_response / send_header / end_headers / wfile,
        # all of which this instance provides. Call the unbound method with
        # our own instance so the feed code needs no changes at all.
        getattr(target.handler, method)(self)

    def do_GET(self):
        self._dispatch('do_GET')

    def do_HEAD(self):
        self._dispatch('do_HEAD')
