"""
OSM building footprint scraper via Overpass API.
Free, no API key required.
"""

import httpx

OVERPASS_URL = "https://overpass-api.de/api/interpreter"


async def fetch_building_footprint(
    lat: float, lon: float, radius_m: float = 50
) -> list[dict] | None:
    """
    Query Overpass API for building footprints near the given coordinates.
    Returns a list of {x, y} points representing the building polygon,
    or None if no building found.
    """
    query = f"""
    [out:json][timeout:10];
    (
      way["building"](around:{radius_m},{lat},{lon});
    );
    out body;
    >;
    out skel qt;
    """

    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(OVERPASS_URL, data={"data": query})
        resp.raise_for_status()
        data = resp.json()

    nodes: dict[int, tuple[float, float]] = {}
    ways: list[list[int]] = []

    for element in data.get("elements", []):
        if element["type"] == "node":
            nodes[element["id"]] = (element["lat"], element["lon"])
        elif element["type"] == "way":
            ways.append(element.get("nodes", []))

    if not ways:
        return None

    # Use the first (closest) building way
    way_nodes = ways[0]

    # Convert lat/lon to relative meters from the first point
    if not way_nodes or way_nodes[0] not in nodes:
        return None

    origin_lat, origin_lon = nodes[way_nodes[0]]
    footprint = []

    for node_id in way_nodes:
        if node_id not in nodes:
            continue
        nlat, nlon = nodes[node_id]
        # Approximate meters from origin using equirectangular projection
        x = (nlon - origin_lon) * 111320 * _cos_deg(origin_lat)
        y = (nlat - origin_lat) * 110540
        footprint.append({"x": round(x, 3), "y": round(y, 3)})

    # Remove duplicate closing point if present
    if len(footprint) > 1 and footprint[0] == footprint[-1]:
        footprint.pop()

    return footprint if len(footprint) >= 3 else None


def _cos_deg(deg: float) -> float:
    import math
    return math.cos(math.radians(deg))
