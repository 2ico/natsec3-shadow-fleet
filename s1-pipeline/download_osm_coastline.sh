#!/usr/bin/env bash
# Download OpenStreetMap land polygons (WGS84) used by filter_land_detections.py.
# Source: https://osmdata.openstreetmap.de/data/land-polygons.html
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="$HERE/data/coastline"
mkdir -p "$DEST"

ZIP="$DEST/land-polygons-complete-4326.zip"
SHP="$DEST/land-polygons-complete-4326/land_polygons.shp"

if [ ! -f "$SHP" ]; then
  URL="https://osmdata.openstreetmap.de/download/land-polygons-complete-4326.zip"
  echo "downloading $URL (~750 MB)"
  curl -fL -o "$ZIP" "$URL"
  echo "unzipping"
  unzip -o -d "$DEST" "$ZIP"
  rm -f "$ZIP"
fi
echo "done: $SHP"
