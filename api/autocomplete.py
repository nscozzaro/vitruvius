"""GET /api/autocomplete?q=... — Returns address suggestions using Nominatim."""

from http.server import BaseHTTPRequestHandler
import json
import urllib.parse
import urllib.request

class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            parsed_path = urllib.parse.urlparse(self.path)
            query_params = urllib.parse.parse_qs(parsed_path.query)
            q = query_params.get("q", [""])[0]

            if not q.strip():
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps([]).encode())
                return

            # Call Nominatim using a valid User-Agent
            url = f"https://nominatim.openstreetmap.org/search?q={urllib.parse.quote(q)}&format=json&addressdetails=1&limit=5&countrycodes=us"
            req = urllib.request.Request(url, headers={"User-Agent": "Vitruvius-Autocomplete/1.0"})
            
            with urllib.request.urlopen(req) as response:
                if response.status != 200:
                    raise Exception(f"Nominatim returned {response.status}")
                data = json.loads(response.read().decode())
                
                # Format the response to be simple strings
                suggestions = [item.get("display_name", "") for item in data if "display_name" in item]

                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(suggestions).encode())
        
        except Exception as e:
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode())
