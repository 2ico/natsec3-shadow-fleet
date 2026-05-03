#!/usr/bin/env python3
"""Convert a Danish AIS daily CSV (DMA format) to a sorted parquet file
suitable for fast time-range + spatial lookups.

Output: data/ais/<date>.parquet with columns
  timestamp (ms epoch), mmsi, imo, lat, lon, sog, cog, heading,
  name, callsign, ship_type, length, width, destination

Sorted by (mmsi, timestamp) so a window lookup "latest position per mmsi at or
before T" is just `MAX(timestamp) FILTER (timestamp <= T) GROUP BY mmsi`.
"""
import sys
from pathlib import Path

import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

CSV = sys.argv[1] if len(sys.argv) > 1 else "data/ais/aisdk-2025-06-12.csv"
OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("data/ais") / (Path(CSV).stem + ".parquet")

USE_COLS = [
    "# Timestamp", "Type of mobile", "MMSI", "Latitude", "Longitude",
    "Navigational status", "ROT", "SOG", "COG", "Heading",
    "IMO", "Callsign", "Name", "Ship type", "Cargo type",
    "Width", "Length", "Type of position fixing device", "Draught",
    "Destination", "ETA",
]

DTYPE = {
    "MMSI": "Int64", "IMO": "string",
    "Latitude": "float32", "Longitude": "float32",
    "SOG": "float32", "COG": "float32", "Heading": "float32",
    "Width": "float32", "Length": "float32",
    "Name": "string", "Callsign": "string", "Ship type": "string",
    "Destination": "string",
}


def main():
    print(f"reading {CSV}", flush=True)
    chunks = []
    nrows = 0
    for i, ch in enumerate(pd.read_csv(CSV, chunksize=2_000_000, low_memory=False, on_bad_lines="skip")):
        nrows += len(ch)
        # standardize column names
        ch = ch.rename(columns={
            "# Timestamp": "ts_str", "MMSI": "mmsi", "IMO": "imo",
            "Latitude": "lat", "Longitude": "lon",
            "SOG": "sog", "COG": "cog", "Heading": "heading",
            "Name": "name", "Callsign": "callsign", "Ship type": "ship_type",
            "Length": "length", "Width": "width", "Destination": "destination",
            "Type of mobile": "mobile_type",
        })
        # parse "06/12/2025 00:00:00" → epoch ms
        ts = pd.to_datetime(ch["ts_str"], format="%d/%m/%Y %H:%M:%S", errors="coerce", utc=True)
        ch["timestamp"] = (ts.astype("int64") // 1_000_000).astype("int64")
        # drop rows with bad timestamp or missing/invalid coords
        ch = ch[ts.notna() & ch["lat"].between(-90, 90) & ch["lon"].between(-180, 180)]
        keep = ["timestamp", "mmsi", "imo", "lat", "lon", "sog", "cog", "heading",
                "name", "callsign", "ship_type", "length", "width", "destination"]
        chunks.append(ch[keep])
        print(f"  chunk {i+1}: cumulative rows {nrows:,}, kept {sum(len(c) for c in chunks):,}", flush=True)

    df = pd.concat(chunks, ignore_index=True)
    print(f"total rows kept: {len(df):,}", flush=True)
    df = df.sort_values(["mmsi", "timestamp"]).reset_index(drop=True)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    table = pa.Table.from_pandas(df, preserve_index=False)
    pq.write_table(table, OUT, compression="zstd")
    print(f"wrote {OUT}  size={OUT.stat().st_size/1e6:.1f} MB", flush=True)


if __name__ == "__main__":
    main()
