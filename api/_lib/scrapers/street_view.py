"""
Street imagery scraper.
- Mapillary: free, requires API key
- Google Street View Static API: 5,000 free/month, requires API key
"""

import os
import httpx


MAPILLARY_API_URL = "https://graph.mapillary.com/images"
GOOGLE_SV_URL = "https://maps.googleapis.com/maps/api/streetview"


async def fetch_mapillary_images(
    lat: float, lon: float, radius_m: int = 100, limit: int = 4
) -> list[dict]:
    """
    Fetch nearby street-level images from Mapillary.
    Returns list of {url, source, description}.
    """
    api_key = os.environ.get("MAPILLARY_ACCESS_TOKEN", "")
    if not api_key:
        return []

    params = {
        "access_token": api_key,
        "fields": "id,thumb_1024_url,captured_at,compass_angle",
        "closeto": f"{lon},{lat}",
        "radius": radius_m,
        "limit": limit,
    }

    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.get(MAPILLARY_API_URL, params=params)
        if resp.status_code != 200:
            return []
        data = resp.json()

    images = []
    for item in data.get("data", []):
        url = item.get("thumb_1024_url")
        if url:
            images.append({
                "url": url,
                "source": "mapillary",
                "description": f"Street view at {item.get('compass_angle', '?')}° (Mapillary {item['id']})",
            })
    return images


async def fetch_google_street_view_urls(
    lat: float, lon: float, headings: list[int] | None = None
) -> list[dict]:
    """
    Generate Google Street View Static API URLs for the given location.
    Default headings: 0° (north), 90° (east), 180° (south), 270° (west).
    Returns list of {url, source, description}.
    """
    api_key = os.environ.get("GOOGLE_STREET_VIEW_API_KEY", "")
    if not api_key:
        return []

    if headings is None:
        headings = [0, 90, 180, 270]

    images = []
    for heading in headings:
        url = (
            f"{GOOGLE_SV_URL}?size=640x480"
            f"&location={lat},{lon}"
            f"&heading={heading}"
            f"&pitch=10&fov=90"
            f"&key={api_key}"
        )
        direction = {0: "North", 90: "East", 180: "South", 270: "West"}.get(
            heading, f"{heading}°"
        )
        images.append({
            "url": url,
            "source": "google_street_view",
            "description": f"Street view facing {direction}",
        })
    return images


async def fetch_street_images(lat: float, lon: float) -> list[dict]:
    """Fetch from both Mapillary and Google Street View."""
    mapillary = await fetch_mapillary_images(lat, lon)
    google = await fetch_google_street_view_urls(lat, lon)
    # Prefer Google (higher quality), Mapillary as supplement
    return google + mapillary
