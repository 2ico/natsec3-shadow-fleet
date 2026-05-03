# s1-pipeline

End-to-end pipeline: download Sentinel-1 GRD → render local XYZ tile pyramid →
run YOLOv8 SAR ship detection → filter land false-positives → overlay AIS.

| Step | Script | Output |
|------|--------|--------|
| 1 | `download_s1_scene.py` / `download_s1_range.py` | `../public/tiles/s1/<date>/{z}/{x}/{y}.png`, `manifest.json` |
| 2 | `download_ais_dma.sh <date>` | `data/ais/aisdk-<date>.csv` + `.parquet` (via `ais_csv_to_parquet.py`) |
| 3 | `download_osm_coastline.sh` | `data/coastline/land-polygons-complete-4326/` |
| 4 | `detect_ships_yolo.py` | `../public/detections/<itemId>.json` |
| 5 | `filter_land_detections.py` | rewrites detections in place, keeps `.raw` backup |

## Setup

```bash
cd s1-pipeline
python3 -m venv .venv
.venv/bin/pip install pystac-client planetary-computer rasterio rio-tiler \
  mercantile pillow numpy pandas pyarrow geopandas shapely \
  huggingface_hub ultralytics
```

## One-shot for a date range

```bash
.venv/bin/python download_s1_range.py 2025-06-11 2025-06-13
./download_ais_dma.sh 2025-06-12
./download_osm_coastline.sh        # one-time, ~750 MB
.venv/bin/python detect_ships_yolo.py
.venv/bin/python filter_land_detections.py
```

The frontend reads everything from `../public/`.
