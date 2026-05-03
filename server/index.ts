import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import duckdb from "duckdb";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// Local AIS lookup backed by Danish DMA daily parquet files. For the given
// scene timestamp, returns the latest known position per MMSI at or before T,
// inside the (buffered) bbox.
const AIS_DIR = path.resolve(process.cwd(), "s1-pipeline/data/ais");
let _duckdbInstance: duckdb.Database | null = null;
function db() {
  if (!_duckdbInstance) _duckdbInstance = new duckdb.Database(":memory:");
  return _duckdbInstance;
}
function dbAll(sql: string, params: any[] = []): Promise<any[]> {
  return new Promise((resolve, reject) => {
    db().all(sql, ...params, (err, rows) => err ? reject(err) : resolve(rows));
  });
}

app.get("/api/ais-local", async (req, res) => {
  try {
    const datetimeStr = String(req.query.datetime ?? "");
    const bboxStr = String(req.query.bbox ?? "");
    const bufferKm = Number(req.query.bufferKm ?? 50);
    const lookbackHours = Number(req.query.lookbackHours ?? 24);
    if (!datetimeStr || !bboxStr) return res.status(400).json({ error: "datetime and bbox required" });
    const dt = new Date(datetimeStr);
    if (isNaN(dt.getTime())) return res.status(400).json({ error: "bad datetime" });

    const dateStr = dt.toISOString().slice(0, 10);
    const parquetPath = path.join(AIS_DIR, `aisdk-${dateStr}.parquet`);
    if (!fs.existsSync(parquetPath)) {
      return res.status(404).json({
        error: "no local AIS parquet for this date",
        expected: parquetPath,
      });
    }

    const [minLon, minLat, maxLon, maxLat] = bboxStr.split(",").map(Number);
    const dLat = bufferKm / 111;
    const midLat = (minLat + maxLat) / 2;
    const dLon = bufferKm / (111 * Math.cos((midLat * Math.PI) / 180));
    const expanded = [minLon - dLon, minLat - dLat, maxLon + dLon, maxLat + dLat];

    // The DMA parquet stores timestamps in *seconds* (pandas dtype quirk in
     // build_ais_parquet.py). Compare in seconds.
    const sceneSec = Math.floor(dt.getTime() / 1000);
    const lookbackSec = sceneSec - lookbackHours * 3600;

    // For each MMSI inside bbox with a ping within [lookback, scene], take the
    // ping with the largest timestamp ≤ scene. Use DuckDB's QUALIFY ROW_NUMBER.
    // Pre-filter to a coarse 5°x5° region around our bbox so duckdb scans less,
    // but DO NOT use the visible bbox here — otherwise a vessel that has since
    // moved out of the bbox would show up clamped to the boundary as its
    // "latest in-bbox ping". We then take latest-per-MMSI and only filter to
    // the actual visible bbox at the end.
    const coarseLatMin = expanded[1] - 2.5, coarseLatMax = expanded[3] + 2.5;
    const coarseLonMin = expanded[0] - 5,   coarseLonMax = expanded[2] + 5;
    const sql = `
      WITH win AS (
        SELECT * FROM read_parquet('${parquetPath.replace(/'/g, "''")}')
        WHERE timestamp <= ${sceneSec}
          AND timestamp >= ${lookbackSec}
          AND lat BETWEEN ${coarseLatMin} AND ${coarseLatMax}
          AND lon BETWEEN ${coarseLonMin} AND ${coarseLonMax}
      ),
      ranked AS (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY mmsi ORDER BY timestamp DESC) AS rn
        FROM win
      )
      SELECT mmsi, imo, lat, lon, sog, cog, heading, name, callsign, ship_type,
             length, width, destination, timestamp
      FROM ranked
      WHERE rn = 1
        AND lat IS NOT NULL AND lon IS NOT NULL
        AND lat BETWEEN ${expanded[1]} AND ${expanded[3]}
        AND lon BETWEEN ${expanded[0]} AND ${expanded[2]}
      ORDER BY timestamp DESC
    `;
    const rows = await dbAll(sql);
    const pings = rows.map((r: any) => ({
      mmsi: String(r.mmsi ?? ""),
      imo: r.imo ?? "",
      lat: Number(r.lat),
      lon: Number(r.lon),
      sog: r.sog == null ? null : Number(r.sog),
      cog: r.cog == null ? null : Number(r.cog),
      heading: r.heading == null ? null : Number(r.heading),
      name: r.name ?? "",
      callsign: r.callsign ?? "",
      type: r.ship_type ?? "",
      length: r.length == null ? null : Number(r.length),
      width: r.width == null ? null : Number(r.width),
      destination: r.destination ?? "",
      time: new Date(Number(r.timestamp) * 1000).toISOString(),
      ageSec: sceneSec - Number(r.timestamp),
    }));

    res.json({
      sceneTime: dt.toISOString(),
      lookbackHours,
      bbox: expanded,
      bufferKm,
      source: `local · ${path.basename(parquetPath)}`,
      pings,
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "failed" });
  }
});

// Serve built client + public assets if present.
const distDir = path.resolve(__dirname, "..", "dist");
const publicDir = path.resolve(__dirname, "..", "public");
app.use(express.static(distDir));
app.use(express.static(publicDir));

const VITE_DEV_URL = process.env.VITE_DEV_URL ?? "http://localhost:3005";
const hasBuild = fs.existsSync(path.join(distDir, "index.html"));

app.get("/", (_req, res) => {
  if (hasBuild) return res.sendFile(path.join(distDir, "index.html"));
  res.redirect(VITE_DEV_URL);
});

app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  if (hasBuild) return res.sendFile(path.join(distDir, "index.html"));
  res
    .status(404)
    .type("text/plain")
    .send(
      `Frontend not built. In development, open ${VITE_DEV_URL}.\n` +
        `For production: pnpm build && pnpm start.\n`,
    );
});

const PORT = parseInt(process.env.PORT ?? "3000", 10);
app.listen(PORT, () => {
  console.log(`Shadow Fleet Detector server online on http://localhost:${PORT}`);
  if (!hasBuild) console.log(`Dev frontend expected at ${VITE_DEV_URL}`);
});
