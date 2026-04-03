"""
Geocoding via OpenStreetMap Nominatim API.
Free, no API key required. Rate limited to 1 request/second.
"""

import httpx

NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"


async def geocode_address(address: str) -> tuple[float, float] | None:
    """
    Convert an address string to (latitude, longitude).
    Returns None if geocoding fails.
    """
    params = {
        "q": address,
        "format": "json",
        "limit": 1,
    }
    headers = {
        "User-Agent": "Vitruvius/0.1 (building-permit-tool)",
    }

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(NOMINATIM_URL, params=params, headers=headers)
            resp.raise_for_status()
            data = resp.json()

        if not data:
            return None

        lat = float(data[0]["lat"])
        lon = float(data[0]["lon"])
        return (lat, lon)
    except (httpx.HTTPError, ValueError, KeyError, IndexError):
        return None
