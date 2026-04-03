"""POST /api/collect_photos — Scrape listing photos from Redfin, Zillow, etc."""

from http.server import BaseHTTPRequestHandler
import json
import asyncio
from api._lib.scrapers.photos import fetch_listing_photos


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            content_length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(content_length))
            address = body["address"]

            photos = asyncio.run(fetch_listing_photos(address))

            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({
                "source": "listing_photos",
                "images": photos,
            }).encode())
        except Exception as e:
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode())
