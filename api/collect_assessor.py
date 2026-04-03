"""POST /api/collect_assessor — Scrape county assessor records."""

from http.server import BaseHTTPRequestHandler
import json
import asyncio
from api._lib.scrapers.assessor import fetch_assessor_data


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            content_length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(content_length))
            address = body["address"]
            lat = body["latitude"]
            lon = body["longitude"]

            assessor = asyncio.run(fetch_assessor_data(address, lat, lon))

            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({
                "source": "assessor",
                "data": assessor,
            }).encode())
        except Exception as e:
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode())
