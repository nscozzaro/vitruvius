"""POST /api/collect_osm — Fetch building footprint from OSM Overpass API."""

from http.server import BaseHTTPRequestHandler
import json
import asyncio
from api._lib.scrapers.osm import fetch_building_footprint


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            content_length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(content_length))
            lat = body["latitude"]
            lon = body["longitude"]

            footprint = asyncio.run(fetch_building_footprint(lat, lon))

            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({
                "source": "osm",
                "footprint": footprint,
            }).encode())
        except Exception as e:
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode())
