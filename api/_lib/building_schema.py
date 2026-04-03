"""
Vitruvius Building JSON Schema — Core IP

This is the intermediate representation between AI output and IFC generation.
Designed to be:
- AI-friendly: Clear hierarchy, natural language field names, no IFC jargon
- IFC-mappable: Every field maps to IFC entities
- Extensible: Optional fields for progressive detail
"""

from pydantic import BaseModel, Field
from typing import Optional
from enum import Enum


# ── Enums ──────────────────────────────────────────────


class WallType(str, Enum):
    EXTERIOR = "exterior"
    INTERIOR = "interior"
    FOUNDATION = "foundation"
    RETAINING = "retaining"


class RoofStyle(str, Enum):
    GABLE = "gable"
    HIP = "hip"
    FLAT = "flat"
    SHED = "shed"
    GAMBREL = "gambrel"
    MANSARD = "mansard"
    DUTCH_GABLE = "dutch_gable"


class OpeningType(str, Enum):
    DOOR = "door"
    WINDOW = "window"
    SLIDING_DOOR = "sliding_door"
    GARAGE_DOOR = "garage_door"
    SKYLIGHT = "skylight"


class StructuralType(str, Enum):
    WOOD_FRAME = "wood_frame"
    STEEL_FRAME = "steel_frame"
    CONCRETE = "concrete"
    MASONRY = "masonry"
    SIP = "sip"


class FoundationType(str, Enum):
    SLAB = "slab"
    CRAWLSPACE = "crawlspace"
    BASEMENT = "basement"
    PIER = "pier"


# ── Geometry Primitives ────────────────────────────────


class Point2D(BaseModel):
    x: float = Field(description="X coordinate in meters from building origin")
    y: float = Field(description="Y coordinate in meters from building origin")


class Point3D(BaseModel):
    x: float
    y: float
    z: float


# ── Building Elements ─────────────────────────────────


class Material(BaseModel):
    name: str = Field(description="e.g. '2x6 SPF', 'concrete', 'drywall'")
    thickness_m: Optional[float] = None


class Opening(BaseModel):
    id: str
    type: OpeningType
    label: Optional[str] = Field(
        None, description="e.g. 'Front Door', 'Kitchen Window W1'"
    )
    width_m: float
    height_m: float
    sill_height_m: float = Field(
        description="Height from floor to bottom of opening"
    )
    wall_offset_m: float = Field(
        description="Distance along wall from wall start point"
    )


class Wall(BaseModel):
    id: str
    type: WallType
    start: Point2D
    end: Point2D
    height_m: float
    thickness_m: float = Field(default=0.15)
    material: Optional[Material] = None
    openings: list[Opening] = Field(default_factory=list)


class Room(BaseModel):
    id: str
    name: str = Field(description="e.g. 'Primary Bedroom', 'Kitchen'")
    wall_ids: list[str] = Field(
        description="Ordered list of wall IDs forming the room boundary"
    )
    floor_finish: Optional[str] = None
    ceiling_height_m: Optional[float] = None


class Staircase(BaseModel):
    id: str
    from_story: str = Field(description="Story ID of lower level")
    to_story: str = Field(description="Story ID of upper level")
    width_m: float
    footprint: list[Point2D] = Field(description="Outline of stair in plan")
    num_risers: int
    riser_height_m: float
    tread_depth_m: float


class RoofPlane(BaseModel):
    outline: list[Point3D] = Field(
        description="3D polygon vertices of this roof plane"
    )
    slope_deg: float


class Roof(BaseModel):
    style: RoofStyle
    ridge_height_m: float = Field(
        description="Height from top-of-wall to ridge"
    )
    overhang_m: float = Field(default=0.6)
    planes: list[RoofPlane] = Field(default_factory=list)
    material: Optional[str] = Field(
        None, description="e.g. 'asphalt shingle', 'standing seam metal'"
    )


class Foundation(BaseModel):
    type: FoundationType
    depth_m: float = Field(description="Depth below grade")
    outline: list[Point2D] = Field(description="Foundation footprint polygon")
    wall_thickness_m: float = Field(default=0.2)


# ── Story / Floor ─────────────────────────────────────


class Story(BaseModel):
    id: str
    name: str = Field(
        description="e.g. 'First Floor', 'Second Floor', 'Basement'"
    )
    elevation_m: float = Field(
        description="Floor elevation relative to grade (0.0)"
    )
    floor_to_floor_height_m: float
    walls: list[Wall] = Field(default_factory=list)
    rooms: list[Room] = Field(default_factory=list)
    staircases: list[Staircase] = Field(default_factory=list)
    slab_thickness_m: float = Field(default=0.15)


# ── Site ──────────────────────────────────────────────


class Site(BaseModel):
    address: str
    latitude: float
    longitude: float
    elevation_m: float = Field(
        description="Ground elevation above sea level (USGS)"
    )
    parcel_polygon: Optional[list[Point2D]] = Field(
        None, description="Property boundary"
    )
    building_footprint: list[Point2D] = Field(
        description="From OSM or assessor data"
    )


# ── Top-Level Building ────────────────────────────────


class Building(BaseModel):
    """
    The core Vitruvius building representation.
    This is the intermediate format between AI output and IFC generation.
    """

    version: str = Field(
        default="0.1.0", description="Schema version for migration"
    )
    id: str
    name: str = Field(description="e.g. '123 Oak Street Renovation'")
    site: Site
    structural_type: StructuralType = Field(default=StructuralType.WOOD_FRAME)
    foundation: Optional[Foundation] = None
    stories: list[Story] = Field(min_length=1)
    roof: Optional[Roof] = None
    year_built: Optional[int] = None
    gross_area_sqm: Optional[float] = None
    description: Optional[str] = Field(
        None, description="Free-text description of the building"
    )
    change_log: list[str] = Field(
        default_factory=list, description="History of AI-applied changes"
    )


# ── Collected Data Models ─────────────────────────────


class CollectedImage(BaseModel):
    url: str
    source: str = Field(description="e.g. 'google_street_view', 'mapillary', 'redfin'")
    description: Optional[str] = None


class AssessorRecord(BaseModel):
    sqft: Optional[float] = None
    lot_sqft: Optional[float] = None
    bedrooms: Optional[int] = None
    bathrooms: Optional[float] = None
    year_built: Optional[int] = None
    stories: Optional[int] = None
    roof_type: Optional[str] = None
    exterior_material: Optional[str] = None
    raw_data: dict = Field(default_factory=dict)


class CollectedData(BaseModel):
    """All data gathered from public sources for a given address."""

    address: str
    latitude: float
    longitude: float
    elevation_m: Optional[float] = None
    building_footprint: Optional[list[Point2D]] = None
    assessor: Optional[AssessorRecord] = None
    images: list[CollectedImage] = Field(default_factory=list)
