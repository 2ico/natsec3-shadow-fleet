#!/usr/bin/env python3
"""Filter YOLO ship detections that fall on land (or within a buffer of the
coastline). Rewrites ../public/detections/<itemId>.json in place, keeping a
backup at <itemId>.json.raw on first run.

Usage:
  ./filter_land_detections.py                 # filter all *.json in public/detections
  ./filter_land_detections.py <itemId>        # filter one
  ./filter_land_detections.py --buffer-km 1   # override default buffer

Backing data: Natural Earth 10m land polygons (data/coastline/ne_10m_land.shp).
"""

import json
import sys
from pathlib import Path

import geopandas as gpd
from shapely.geometry import Point, box
from shapely.strtree import STRtree

# Manual exclusion polygons: features visible in SAR that aren't in OSM
# land_polygons (offshore platforms, wind farms, persistent SAR artifacts,
# unmapped islets). Each entry is (lon_min, lat_min, lon_max, lat_max, note).
# Treated identically to land for the ≥10% bbox-overlap rule.
MANUAL_EXCLUSIONS = [
    (11.5396, 57.8214, 11.5456, 57.8274, "unmapped feature ~57.8244,11.5426"),
]

ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT.parent / "public" / "detections"
LAND_SHPS = [
    # OpenStreetMap simplified land polygons (EPSG:3857) — captures every
    # mapped islet, includes the dense Danish archipelago.
    ROOT / "data" / "coastline" / "land-polygons-complete-4326" / "land_polygons.shp",
]

# Bounding box of our scenes: clip the world coastline to the area of interest
# so the spatial index stays tiny and queries are O(1).
CLIP_BBOX = (5.0, 54.0, 16.0, 60.5)  # Denmark + neighbours, generous


def load_land(buffer_km: float):
    """Load NE land polygons, clip to our region, and buffer by buffer_km.
    Returns (geom_list, strtree)."""
    minx, miny, maxx, maxy = CLIP_BBOX
    parts = []
    for shp in LAND_SHPS:
        if not shp.exists():
            print(f"  skip {shp.name} (missing)", flush=True); continue
        sub = gpd.read_file(shp)
        if sub.crs is None or str(sub.crs) != "EPSG:4326":
            sub = sub.to_crs("EPSG:4326")
        sub = sub.cx[minx:maxx, miny:maxy]
        print(f"  {shp.name}: {len(sub)} polygons in clip bbox", flush=True)
        parts.append(sub)
    gdf = gpd.GeoDataFrame(__import__("pandas").concat(parts, ignore_index=True), crs="EPSG:4326")
    print(f"  total: {len(gdf)} land polygons", flush=True)

    # buffer in metric CRS so the buffer is in km, not degrees
    metric = gdf.to_crs("EPSG:3857")
    metric["geometry"] = metric.buffer(buffer_km * 1000)
    buffered = metric.to_crs("EPSG:4326")
    geoms = list(buffered.geometry)
    for x0, y0, x1, y1, note in MANUAL_EXCLUSIONS:
        geoms.append(box(x0, y0, x1, y1))
        print(f"  + manual exclusion: {note}", flush=True)
    tree = STRtree(geoms)
    return geoms, tree


LAND_FRACTION_THRESHOLD = 0.10  # reject detection if ≥10% of its bbox is land


def filter_one(path: Path, geoms, tree):
    raw_path = path.with_suffix(path.suffix + ".raw")
    if not raw_path.exists():
        raw_path.write_bytes(path.read_bytes())
    data = json.loads(raw_path.read_text())
    dets = data.get("detections", [])
    kept = []
    dropped = 0
    for d in dets:
        # Build the detection bbox as a polygon in WGS84 (lat/lon).
        # Note lon/lat ordering: shapely uses (x=lon, y=lat).
        x0, x1 = sorted((d["lon0"], d["lon1"]))
        y0, y1 = sorted((d["lat0"], d["lat1"]))
        bbox = box(x0, y0, x1, y1)
        bbox_area = bbox.area
        if bbox_area <= 0:
            kept.append(d); continue
        # Sum intersection area against any land polygon whose bbox overlaps.
        candidates = tree.query(bbox)
        land_area = 0.0
        for idx in candidates:
            inter = geoms[int(idx)].intersection(bbox)
            if not inter.is_empty:
                land_area += inter.area
                # Early exit if we already crossed the threshold.
                if land_area / bbox_area >= LAND_FRACTION_THRESHOLD:
                    break
        if land_area / bbox_area >= LAND_FRACTION_THRESHOLD:
            dropped += 1
        else:
            kept.append(d)
    data["detections"] = kept
    data["landFilter"] = {
        "droppedOnLand": dropped, "kept": len(kept), "raw": len(dets),
        "rule": f"≥{int(LAND_FRACTION_THRESHOLD*100)}% of bbox on land",
    }
    path.write_text(json.dumps(data, indent=2))
    print(f"  {path.name}: {len(dets)} → {len(kept)} ({dropped} dropped)", flush=True)


def main():
    args = sys.argv[1:]
    buffer_km = 0.5
    while "--buffer-km" in args:
        i = args.index("--buffer-km")
        buffer_km = float(args[i + 1]); del args[i:i + 2]
    print(f"buffer_km={buffer_km}", flush=True)

    geoms, tree = load_land(buffer_km)

    if args:
        target = args[0]
        for f in PUBLIC.glob("*.json"):
            if target in f.name:
                filter_one(f, geoms, tree)
        return
    for f in sorted(PUBLIC.glob("*.json")):
        filter_one(f, geoms, tree)


if __name__ == "__main__":
    main()
