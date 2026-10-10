#!/usr/bin/env python3
"""Optional development-only static file server. The published app needs no
backend or Python process; GitHub Pages serves the same files over HTTPS.
"""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import argparse
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--port',type=int,default=8765)
args=parser.parse_args()
root=Path(__file__).resolve().parents[1]
class Handler(SimpleHTTPRequestHandler):
    def __init__(self,*a,**kw): super().__init__(*a,directory=str(root),**kw)
    def end_headers(self):
        self.send_header('Cache-Control','no-cache')
        super().end_headers()
Handler.extensions_map.update({'.wasm':'application/wasm','.mjs':'text/javascript'})
print(f'Static development preview: http://localhost:{args.port}/#recite',flush=True)
ThreadingHTTPServer(('127.0.0.1',args.port),Handler).serve_forever()
