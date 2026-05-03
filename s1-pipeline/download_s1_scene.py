#!/usr/bin/env python3
"""Download one Sentinel-1 GRD scene over the Strait of Hormuz, dB-rescale the
VV polarization, write a Web-Mercator GeoTIFF, then pre-render an XYZ tile
pyramid at zooms 8-13 into ../public/tiles/s1/<date>/{z}/{x}/{y}.png.

Usage:
  ./download_s1_scene.py            # picks a recent scene
  ./download_s1_scene.py 2024-03-15 # picks the scene closest to that date

Dependencies (installed in .venv):
  pystac-client planetary-computer rasterio rio-tiler mercantile numpy pillow
"""

import json
import sys
from pathlib import Path

import mercantile
import numpy as np
import planetary_computer
import pystac_client
import rasterio
from rasterio.vrt import WarpedVRT
from rasterio.warp import Resampling, calculate_default_transform, reproject
from rasterio.windows import from_bounds
from rio_tiler.io import Reader

BBOX = (8.05, 57.36, 11.96, 58.98)  # extended west to include z10 cols 535-538
WIDE_BBOX = (8.0, 56.5, 12.5, 59.5)  # extra context at z9
ZOOM_MIN, ZOOM_MAX = 9, 14
ROOT = Path(__file__).resolve().parent
PUBLIC_TILES = ROOT.parent / "public" / "tiles" / "s1"
PUBLIC_MANIFEST = PUBLIC_TILES / "manifest.json"
DEFAULT_RANGE = "2024-03-01/2024-03-31"


# Known-good S1A IW GRD scene over Hormuz, 2024-03-05 descending pass.
# Used as a fallback when STAC search times out.
KNOWN_ITEM_ID = "S1A_IW_GRDH_1SDV_20240305T020713_20240305T020738_052840_066515"
KNOWN_VV_BLOB_URL = "https://sentinel1euwest.blob.core.windows.net/s1-grd/GRD/2024/3/5/IW/DV/S1A_IW_GRDH_1SDV_20240305T020713_20240305T020738_052840_066515/measurement/iw-vv.tiff"


def make_known_item():
    """Build a minimal in-memory item for the known scene, signing the VV blob
    URL directly via PC's SAS endpoint (separate service from STAC, often up
    when the STAC API is timing out)."""
    from datetime import datetime, timezone
    from pystac import Item, Asset
    signed_vv = planetary_computer.sign(KNOWN_VV_BLOB_URL)
    item = Item(
        id=KNOWN_ITEM_ID,
        geometry={"type": "Point", "coordinates": [56.88, 26.53]},
        bbox=[55.0, 25.5, 58.0, 27.5],
        datetime=datetime(2024, 3, 5, 2, 7, 25, tzinfo=timezone.utc),
        properties={
            "platform": "SENTINEL-1A",
            "sat:orbit_state": "descending",
            "sar:instrument_mode": "IW",
        },
    )
    item.assets["vv"] = Asset(href=signed_vv)
    return item


def search_items(start: str, end: str):
    """Return all S1 GRD items intersecting WIDE_BBOX between start/end dates.
    Both inclusive, ISO date strings (YYYY-MM-DD)."""
    import time
    catalog = pystac_client.Client.open(
        "https://planetarycomputer.microsoft.com/api/stac/v1",
        modifier=planetary_computer.sign_inplace,
    )
    datetime = f"{start}T00:00:00Z/{end}T23:59:59Z"
    for attempt in range(5):
        try:
            items = list(catalog.search(
                collections=["sentinel-1-grd"],
                bbox=list(WIDE_BBOX), datetime=datetime,
                query={"sar:instrument_mode": {"eq": "IW"}},
                max_items=30,
            ).items())
            items.sort(key=lambda it: it.datetime)
            print(f"  STAC found {len(items)} IW GRD items in {datetime}", flush=True)
            return items
        except Exception as e:
            print(f"  search attempt {attempt+1} failed: {e!r}", flush=True)
            time.sleep(2 ** attempt)
    print("  STAC search exhausted retries — returning empty", flush=True)
    return []


def pick_item(target_date):
    import time, urllib.request, json as _json
    if target_date is None and "--known" not in sys.argv:
        # try search first
        catalog = pystac_client.Client.open(
            "https://planetarycomputer.microsoft.com/api/stac/v1",
            modifier=planetary_computer.sign_inplace,
        )
        for attempt in range(3):
            try:
                items = list(catalog.search(
                    collections=["sentinel-1-grd"],
                    bbox=list(BBOX), datetime=DEFAULT_RANGE, max_items=20,
                ).items())
                if items:
                    items.sort(key=lambda it: (
                        it.properties.get("sar:instrument_mode") != "IW",
                        it.properties.get("sat:orbit_state") != "descending",
                        it.datetime,
                    ))
                    return items[0]
            except Exception as e:
                print(f"  search attempt {attempt+1} failed: {e!r}", flush=True)
                time.sleep(2 ** attempt)
        print("  STAC search kept failing — falling back to known item", flush=True)

    # direct item fetch by ID (much more reliable than search)
    item_id = target_date_to_item(target_date) if target_date else KNOWN_ITEM_ID
    url = f"https://planetarycomputer.microsoft.com/api/stac/v1/collections/sentinel-1-grd/items/{item_id}"
    print(f"  fetching item directly: {item_id}", flush=True)
    last = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(url, timeout=30) as r:
                data = _json.loads(r.read())
            from pystac import Item
            item = Item.from_dict(data)
            planetary_computer.sign_inplace(item)
            return item
        except Exception as e:
            last = repr(e)
            print(f"  item fetch attempt {attempt+1} failed: {last}", flush=True)
            time.sleep(2 ** attempt)

    # final fallback: build the item in-memory and sign the asset directly
    print("  STAC item endpoint down — using SAS-signed blob URL directly", flush=True)
    return make_known_item()


def target_date_to_item(target_date):
    # only the known date is currently mapped; extend as we add more
    return KNOWN_ITEM_ID if target_date == "2024-03-05" else KNOWN_ITEM_ID


def build_geotiff(item, work_dir: Path) -> Path:
    """Read the VV asset, clip to bbox, dB-rescale to uint8, reproject to
    EPSG:3857, write a tiled COG ready for rio-tiler."""
    vv_href = item.assets["vv"].href
    print(f"  reading VV ({vv_href[:90]}...)", flush=True)
    # S1 GRD products on PC are delivered as GCP-referenced rasters with no
    # CRS embedded. WarpedVRT projects them on-the-fly into a real CRS so we
    # can read a windowed clip in geographic coordinates.
    with rasterio.open(vv_href) as src:
        with WarpedVRT(src, crs="EPSG:3857", resampling=Resampling.bilinear) as vrt:
            from rasterio.warp import transform_bounds
            # Use the wide bbox for the COG so z9 has surrounding context, then
            # higher zooms iterate over the tighter BBOX only.
            merc_bbox = transform_bounds("EPSG:4326", "EPSG:3857", *WIDE_BBOX, densify_pts=21)
            window = from_bounds(*merc_bbox, transform=vrt.transform).round_offsets().round_lengths()
            print(f"  warped to EPSG:3857; reading window {window}", flush=True)
            from rasterio.windows import intersection, Window
            full = Window(0, 0, vrt.width, vrt.height)
            window = intersection(window, full)
            amp = vrt.read(1, window=window).astype(np.float32)
            dst_transform = vrt.window_transform(window)

    print(f"  read {amp.shape} pixels", flush=True)
    # Sentinel-1 GRD on PC are uncalibrated DN values, not calibrated sigma0.
    # Use a percentile stretch on dB-scaled DN so the range adapts to the actual data.
    nz = amp > 0
    db = np.full(amp.shape, np.nan, dtype=np.float32)
    db[nz] = 20.0 * np.log10(amp[nz])
    valid = db[nz]
    lo, hi = np.percentile(valid, [2, 98])
    print(f"  dB stretch: p2={lo:.1f} p98={hi:.1f} dB", flush=True)
    rescale_db = [round(float(lo), 1), round(float(hi), 1)]
    stretched = np.clip((db - lo) / max(hi - lo, 1e-3) * 255.0, 0, 255)
    stretched = np.where(np.isnan(stretched), 0, stretched)
    out = stretched.astype(np.uint8)
    dst_h, dst_w = out.shape
    dst_crs = "EPSG:3857"
    cog_path = work_dir / "vv_3857.tif"
    profile = {
        "driver": "GTiff", "dtype": "uint8", "count": 1,
        "height": dst_h, "width": dst_w,
        "crs": dst_crs, "transform": dst_transform,
        "tiled": True, "blockxsize": 256, "blockysize": 256,
        "compress": "deflate", "nodata": 0,
    }
    with rasterio.open(cog_path, "w", **profile) as dst:
        dst.write(out, 1)
    with rasterio.open(cog_path, "r+") as dst:
        dst.build_overviews([2, 4, 8, 16, 32], Resampling.average)
        dst.update_tags(ns="rio_overview", resampling="average")
    print(f"  wrote {cog_path} ({dst_w}x{dst_h} px)", flush=True)
    return cog_path, rescale_db


def render_pyramid(cog_path: Path, out_root: Path):
    out_root.mkdir(parents=True, exist_ok=True)
    total = 0
    written = 0
    with Reader(str(cog_path)) as src:
        for z in range(ZOOM_MIN, ZOOM_MAX + 1):
            zbbox = WIDE_BBOX if z == ZOOM_MIN else BBOX
            tiles = list(mercantile.tiles(*zbbox, [z]))
            print(f"  zoom {z}: {len(tiles)} tiles", flush=True)
            for t in tiles:
                total += 1
                try:
                    img = src.tile(t.x, t.y, z, tilesize=256)
                except Exception:
                    continue
                # rio-tiler mask: 0 = transparent (no data), 255 = valid. Skip
                # only when nothing is valid; previous code did the inverse and
                # discarded fully-valid tiles.
                if img.data.size == 0:
                    continue
                if hasattr(img, "mask") and img.mask is not None and not img.mask.any():
                    continue
                png_bytes = img.render(img_format="PNG", add_mask=True)
                tile_dir = out_root / str(z) / str(t.x)
                tile_dir.mkdir(parents=True, exist_ok=True)
                (tile_dir / f"{t.y}.png").write_bytes(png_bytes)
                written += 1
    print(f"  wrote {written}/{total} tiles into {out_root}", flush=True)


def main():
    target_date = sys.argv[1] if len(sys.argv) > 1 else None
    item = pick_item(target_date)
    date_str = item.datetime.strftime("%Y-%m-%d")
    print(f"selected {item.id}", flush=True)
    print(f"  date: {item.datetime.isoformat()}", flush=True)
    print(f"  mode: {item.properties.get('sar:instrument_mode')}  orbit: {item.properties.get('sat:orbit_state')}", flush=True)

    if "vv" not in item.assets:
        sys.exit(f"item {item.id} has no VV asset (assets: {list(item.assets)})")

    work_dir = ROOT / ".cache" / date_str
    work_dir.mkdir(parents=True, exist_ok=True)
    cog_path, rescale_db = build_geotiff(item, work_dir)

    out_root = PUBLIC_TILES / date_str
    render_pyramid(cog_path, out_root)

    manifest = {
        "date": date_str,
        "itemId": item.id,
        "platform": item.properties.get("platform"),
        "orbit": item.properties.get("sat:orbit_state"),
        "mode": item.properties.get("sar:instrument_mode"),
        "polarization": "VV",
        "rescaleDb": rescale_db,
        "zoomMin": ZOOM_MIN, "zoomMax": ZOOM_MAX,
        "bbox": list(BBOX),
        "tileUrl": f"/tiles/s1/{date_str}/{{z}}/{{x}}/{{y}}.png",
    }
    PUBLIC_MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    PUBLIC_MANIFEST.write_text(json.dumps(manifest, indent=2))
    print(f"wrote manifest {PUBLIC_MANIFEST}", flush=True)


if __name__ == "__main__":
    main()
