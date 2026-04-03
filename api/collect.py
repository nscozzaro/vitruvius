"""POST /api/collect — Geocode an address and return coordinates for parallel collection."""

from http.server import BaseHTTPRequestHandler
import json
import asyncio
from api._lib.scrapers.geocode import geocode_address


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            content_length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(content_length))
            address = body["address"]

            coords = asyncio.run(geocode_address(address))

            if coords is None:
                self.send_response(404)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({
                    "error": "Could not geocode address"
                }).encode())
                return

            lat, lon = coords

            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({
                "address": address,
                "latitude": lat,
                "longitude": lon,
            }).encode())
        except Exception as e:
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode())
