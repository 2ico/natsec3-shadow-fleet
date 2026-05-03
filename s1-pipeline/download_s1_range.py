#!/usr/bin/env python3
"""Fetch every Sentinel-1 GRD scene over the WIDE_BBOX for a date range
(default: 2024-03-04 .. 2024-03-06), build a per-scene tile pyramid, and write
a top-level manifest the frontend uses to populate a slider.

Each scene goes under ../public/tiles/s1/<itemId>/{z}/{x}/{y}.png and is
listed in ../public/tiles/s1/manifest.json with its acquisition timestamp."""

import json
import sys
from pathlib import Path

import download_s1_scene as f1


def main():
    start = sys.argv[1] if len(sys.argv) > 1 else "2024-03-04"
    end = sys.argv[2] if len(sys.argv) > 2 else "2024-03-06"
    items = f1.search_items(start, end)
    if not items:
        sys.exit(f"no items found for {start}..{end}")

    # Multiple consecutive S1 strips share the same orbit number (e.g. _052840_).
    # Keep only one strip per date — the one whose footprint center is closest
    # to our bbox center — and skip the rest.
    bb_cx = (f1.BBOX[0] + f1.BBOX[2]) / 2
    bb_cy = (f1.BBOX[1] + f1.BBOX[3]) / 2

    def dist(it):
        b = it.bbox or [0, 0, 0, 0]
        cx = (b[0] + b[2]) / 2
        cy = (b[1] + b[3]) / 2
        return (cx - bb_cx) ** 2 + (cy - bb_cy) ** 2

    by_date: dict[str, list] = {}
    for it in items:
        by_date.setdefault(it.datetime.strftime("%Y-%m-%d"), []).append(it)
    chosen = []
    for date_str, group in sorted(by_date.items()):
        group.sort(key=dist)
        chosen.append(group[0])
    print(f"  picked {len(chosen)} items, one per date: {[it.id[:50] for it in chosen]}", flush=True)
    items = chosen

    scenes = []
    for item in items:
        date_str = item.datetime.strftime("%Y-%m-%d")
        print(f"\n→ {item.id}  ({item.datetime.isoformat()})", flush=True)
        if "vv" not in item.assets:
            print("  no VV asset, skipping", flush=True)
            continue

        work_dir = f1.ROOT / ".cache" / item.id
        work_dir.mkdir(parents=True, exist_ok=True)
        cog_path = work_dir / "vv_3857.tif"
        if cog_path.exists():
            print(f"  reusing cached COG {cog_path}", flush=True)
            # we still need the rescale_db; recompute trivially from COG
            import rasterio, numpy as np
            with rasterio.open(cog_path) as src:
                d = src.read(1)
            nz = d[d > 0]
            rescale_db = [round(float(np.percentile(nz, 2)) if nz.size else 0, 1),
                          round(float(np.percentile(nz, 98)) if nz.size else 255, 1)]
        else:
            import time
            cog_path, rescale_db = None, None
            for attempt in range(3):
                try:
                    cog_path, rescale_db = f1.build_geotiff(item, work_dir)
                    break
                except Exception as e:
                    print(f"  build_geotiff attempt {attempt+1} failed: {e!r}", flush=True)
                    time.sleep(5 + attempt * 5)
            if cog_path is None:
                print(f"  giving up on {item.id}", flush=True)
                continue

        out_dir = f1.PUBLIC_TILES / item.id
        f1.render_pyramid(cog_path, out_dir)

        scenes.append({
            "id": item.id,
            "date": date_str,
            "datetime": item.datetime.isoformat(),
            "platform": item.properties.get("platform"),
            "orbit": item.properties.get("sat:orbit_state"),
            "mode": item.properties.get("sar:instrument_mode"),
            "polarization": "VV",
            "rescaleDb": rescale_db,
            "zoomMin": f1.ZOOM_MIN,
            "zoomMax": f1.ZOOM_MAX,
            "bbox": list(f1.BBOX),
            "wideBbox": list(f1.WIDE_BBOX),
            "tileUrl": f"/tiles/s1/{item.id}/{{z}}/{{x}}/{{y}}.png",
        })

    manifest = {"scenes": scenes}
    f1.PUBLIC_MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    f1.PUBLIC_MANIFEST.write_text(json.dumps(manifest, indent=2))
    print(f"\nwrote manifest with {len(scenes)} scenes → {f1.PUBLIC_MANIFEST}", flush=True)


if __name__ == "__main__":
    main()
