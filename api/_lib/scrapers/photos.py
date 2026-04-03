"""
Internet photo scraper for property listing images.
Searches Redfin, Zillow, and Google Images for exterior/interior photos.
"""

import re
import httpx
from bs4 import BeautifulSoup

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
}


async def fetch_listing_photos(address: str) -> list[dict]:
    """
    Scrape property listing photos from multiple sources.
    Returns list of {url, source, description}.
    """
    results = []

    redfin_photos = await _scrape_redfin(address)
    results.extend(redfin_photos)

    zillow_photos = await _scrape_zillow(address)
    results.extend(zillow_photos)

    return results


async def _scrape_redfin(address: str) -> list[dict]:
    """Search Redfin for property listing photos."""
    search_url = "https://www.redfin.com/stingray/do/location-autocomplete"
    params = {"location": address, "v": 2}

    try:
        async with httpx.AsyncClient(
            timeout=15, headers=HEADERS, follow_redirects=True
        ) as client:
            # Step 1: Search for the property
            resp = await client.get(search_url, params=params)
            if resp.status_code != 200:
                return []

            # Redfin returns JSONP-like response
            text = resp.text
            # Try to extract a property URL from the response
            url_match = re.search(r'"url":"(/[^"]+)"', text)
            if not url_match:
                return []

            property_url = f"https://www.redfin.com{url_match.group(1)}"

            # Step 2: Fetch the property page
            resp = await client.get(property_url)
            if resp.status_code != 200:
                return []

            soup = BeautifulSoup(resp.text, "html.parser")
            return _extract_redfin_images(soup)
    except (httpx.HTTPError, Exception):
        return []


def _extract_redfin_images(soup: BeautifulSoup) -> list[dict]:
    """Extract image URLs from a Redfin property page."""
    images = []
    for img in soup.find_all("img", src=True):
        src = img["src"]
        if "photo" in src.lower() or "genMid" in src:
            images.append({
                "url": src,
                "source": "redfin",
                "description": img.get("alt", "Redfin listing photo"),
            })
        if len(images) >= 10:
            break
    return images


async def _scrape_zillow(address: str) -> list[dict]:
    """Search Zillow for property listing photos."""
    search_url = "https://www.zillow.com/homes/"
    # Zillow URL format: address-with-dashes
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", address).strip("-")
    url = f"{search_url}{slug}_rb/"

    try:
        async with httpx.AsyncClient(
            timeout=15, headers=HEADERS, follow_redirects=True
        ) as client:
            resp = await client.get(url)
            if resp.status_code != 200:
                return []

            soup = BeautifulSoup(resp.text, "html.parser")
            return _extract_zillow_images(soup)
    except (httpx.HTTPError, Exception):
        return []


def _extract_zillow_images(soup: BeautifulSoup) -> list[dict]:
    """Extract image URLs from a Zillow property page."""
    images = []
    for img in soup.find_all("img", src=True):
        src = img["src"]
        if "zillowstatic" in src or "photos" in src.lower():
            images.append({
                "url": src,
                "source": "zillow",
                "description": img.get("alt", "Zillow listing photo"),
            })
        if len(images) >= 10:
            break
    return images
