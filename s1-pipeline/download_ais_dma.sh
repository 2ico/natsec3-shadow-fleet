#!/usr/bin/env bash
# Download a Danish Maritime Authority daily AIS CSV and convert to parquet.
# Usage: ./download_ais_dma.sh 2025-06-12
set -euo pipefail
DATE="${1:-2025-06-12}"
HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="$HERE/data/ais"
mkdir -p "$DEST"

ZIP="$DEST/aisdk-$DATE.zip"
CSV="$DEST/aisdk-$DATE.csv"
PARQ="$DEST/aisdk-$DATE.parquet"

if [ ! -f "$CSV" ]; then
  URL="http://web.ais.dk/aisdata/aisdk-$DATE.zip"
  echo "downloading $URL"
  curl -fL -o "$ZIP" "$URL"
  echo "unzipping"
  unzip -o -d "$DEST" "$ZIP"
  rm -f "$ZIP"
fi

if [ ! -f "$PARQ" ]; then
  echo "building parquet"
  "$HERE/.venv/bin/python" "$HERE/ais_csv_to_parquet.py" "$CSV" "$PARQ"
fi
echo "done: $PARQ"
