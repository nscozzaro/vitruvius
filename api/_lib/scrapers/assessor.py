"""
County assessor record scraper.
Scrapes public property records by address.
Uses multiple strategies depending on the county.
"""

import re
import httpx
from bs4 import BeautifulSoup


async def fetch_assessor_data(address: str, lat: float, lon: float) -> dict | None:
    """
    Attempt to scrape county assessor records for the given address.
    Returns a dict with available fields, or None if scraping fails.

    Fields: sqft, lot_sqft, bedrooms, bathrooms, year_built, stories,
            roof_type, exterior_material, raw_data
    """
    # Try multiple free property data sources
    result = await _try_county_assessor_generic(address)
    if result:
        return result

    return None


async def _try_county_assessor_generic(address: str) -> dict | None:
    """
    Generic assessor scraper that searches common public records sites.
    This is a best-effort scraper — many counties have different formats.
    """
    search_url = "https://www.countyoffice.org/property-records-search/"
    params = {"q": address}

    try:
        async with httpx.AsyncClient(
            timeout=20,
            headers={"User-Agent": "Mozilla/5.0 (compatible; Vitruvius/0.1)"},
            follow_redirects=True,
        ) as client:
            resp = await client.get(search_url, params=params)
            if resp.status_code != 200:
                return None

            soup = BeautifulSoup(resp.text, "html.parser")
            return _parse_property_details(soup)
    except (httpx.HTTPError, Exception):
        return None


def _parse_property_details(soup: BeautifulSoup) -> dict | None:
    """Extract property details from a parsed HTML page."""
    raw_data = {}
    result = {
        "sqft": None,
        "lot_sqft": None,
        "bedrooms": None,
        "bathrooms": None,
        "year_built": None,
        "stories": None,
        "roof_type": None,
        "exterior_material": None,
        "raw_data": raw_data,
    }

    text = soup.get_text(" ", strip=True).lower()

    # Extract square footage
    sqft_match = re.search(r"(?:living\s*area|building\s*area|sqft|sq\s*ft)[:\s]*(\d[\d,]*)", text)
    if sqft_match:
        result["sqft"] = float(sqft_match.group(1).replace(",", ""))

    # Extract lot size
    lot_match = re.search(r"(?:lot\s*(?:size|area))[:\s]*(\d[\d,]*)", text)
    if lot_match:
        result["lot_sqft"] = float(lot_match.group(1).replace(",", ""))

    # Extract bedrooms
    bed_match = re.search(r"(\d+)\s*(?:bed(?:room)?s?)", text)
    if bed_match:
        result["bedrooms"] = int(bed_match.group(1))

    # Extract bathrooms
    bath_match = re.search(r"(\d+\.?\d*)\s*(?:bath(?:room)?s?)", text)
    if bath_match:
        result["bathrooms"] = float(bath_match.group(1))

    # Extract year built
    year_match = re.search(r"(?:year\s*built|built\s*in)[:\s]*(\d{4})", text)
    if year_match:
        result["year_built"] = int(year_match.group(1))

    # Extract stories
    story_match = re.search(r"(\d+)\s*(?:stor(?:y|ies))", text)
    if story_match:
        result["stories"] = int(story_match.group(1))

    # Only return if we found at least one useful field
    has_data = any(v is not None for k, v in result.items() if k != "raw_data")
    return result if has_data else None
