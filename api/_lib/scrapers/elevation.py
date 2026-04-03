"""
USGS Elevation Point Query Service.
Free, no API key required.
"""

import httpx

USGS_ELEVATION_URL = "https://epqs.nationalmap.gov/v1/json"


async def fetch_elevation(lat: float, lon: float) -> float | None:
    """
    Query USGS National Map Elevation Point Query Service.
    Returns elevation in meters, or None on failure.
    """
    params = {
        "x": lon,
        "y": lat,
        "wkid": 4326,
        "units": "Meters",
        "includeDate": False,
    }

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(USGS_ELEVATION_URL, params=params)
            resp.raise_for_status()
            data = resp.json()

        value = data.get("value")
        if value is not None:
            return round(float(value), 2)
        return None
    except (httpx.HTTPError, ValueError, KeyError):
        return None
