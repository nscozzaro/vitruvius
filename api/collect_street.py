"""POST /api/collect_street — Fetch street imagery from Mapillary + Google Street View."""

from http.server import BaseHTTPRequestHandler
import json
import asyncio
from api._lib.scrapers.street_view import fetch_street_images


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            content_length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(content_length))
            lat = body["latitude"]
            lon = body["longitude"]

            images = asyncio.run(fetch_street_images(lat, lon))

            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({
                "source": "street_view",
                "images": images,
            }).encode())
        except Exception as e:
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode())
