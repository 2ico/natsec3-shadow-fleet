import React, { startTransition, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { CircleMarker, MapContainer, Marker, Polyline, Rectangle, TileLayer, Tooltip, useMapEvents } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { THEME } from "./theme";

// Skagerrak westbound traffic separation scheme: 81 vessels in a 30m-wide
// strip at lon ≈8.780°, spanning lat 56.93° to 58.47° at scene time.
const ROUTE_T: Array<[number, number]> = [[58.47, 8.780], [56.93, 8.780]];
const ROUTE_T_LABEL_POS: [number, number] = [57.7, 8.780];
const CENTER: [number, number] = [57.7320, 10.6567];
const ZOOM = 10;

type Scene = {
  id: string;
  date: string;
  datetime: string;
  platform: string;
  orbit: string;
  mode: string;
  polarization: string;
  rescaleDb: [number, number];
  zoomMin: number;
  zoomMax: number;
  bbox: [number, number, number, number];
  tileUrl: string;
};
type Manifest = { scenes: Scene[] };

function MapTracker({ onZoom, onMouse, onCenter }: {
  onZoom: (z: number) => void;
  onMouse: (latLng: [number, number] | null) => void;
  onCenter: (latLng: [number, number]) => void;
}) {
  const map = useMapEvents({
    zoomend: () => { onZoom(map.getZoom()); onCenter([map.getCenter().lat, map.getCenter().lng]); },
    moveend: () => onCenter([map.getCenter().lat, map.getCenter().lng]),
    mousemove: (e) => onMouse([e.latlng.lat, e.latlng.lng]),
    mouseout: () => onMouse(null),
  });
  useEffect(() => {
    onZoom(map.getZoom());
    onCenter([map.getCenter().lat, map.getCenter().lng]);
  }, [map]);
  return null;
}

// Cached AIS triangle icons keyed by (color, small, headingBucket). Triangle
// apex angle = 15°, apex points in the heading direction (0° = North, CW).
// Heading bucketed to 5° to keep cache small. If heading is missing/invalid
// the triangle points north and is drawn dashed to flag it.
const _aisIconCache = new Map<string, L.DivIcon>();
function aisTriIcon(color: string, small: boolean, heading: number | null) {
  const validHdg = heading != null && Number.isFinite(heading) && heading < 360;
  const hdg = validHdg ? Math.round((heading as number) / 5) * 5 : 0;
  const key = `${color}|${small ? "s" : "f"}|${validHdg ? hdg : "x"}`;
  let icon = _aisIconCache.get(key);
  if (!icon) {
    const len = small ? 9 : 14;          // along-heading length
    const halfBase = len * Math.tan((15 / 2) * Math.PI / 180); // 15° apex
    const pad = 2;
    const box = Math.ceil(len + pad * 2);
    const cx = box / 2;
    const cy = box / 2;
    const apex = `${cx},${cy - len / 2}`;
    const baseL = `${cx - halfBase},${cy + len / 2}`;
    const baseR = `${cx + halfBase},${cy + len / 2}`;
    const dash = validHdg ? "" : `stroke-dasharray="1.5 1.5"`;
    const html = `<svg xmlns="http://www.w3.org/2000/svg" width="${box}" height="${box}" viewBox="0 0 ${box} ${box}" style="display:block;filter:drop-shadow(0 0 2px ${color}cc)">
      <polygon points="${apex} ${baseL} ${baseR}"
        fill="${color}33" stroke="${color}" stroke-width="${small ? 1.1 : 1.4}"
        stroke-linejoin="round" ${dash}
        transform="rotate(${hdg} ${cx} ${cy})" />
    </svg>`;
    icon = L.divIcon({
      html, className: "ais-tri",
      iconSize: [box, box], iconAnchor: [cx, cy],
    });
    _aisIconCache.set(key, icon);
  }
  return icon;
}

function Kv({ k, v, colour }: { k: string; v: string; colour?: string }) {
  return (
    <div style={{ display: "flex", gap: 8 }}>
      <span style={{ color: "#555", width: 70, fontSize: 9, letterSpacing: 0.8 }}>{k}</span>
      <span style={{ color: colour ?? "inherit", flex: 1, fontVariantNumeric: "tabular-nums" }}>{v}</span>
    </div>
  );
}

// Web Mercator lat/lon → XYZ tile coords. Used to display the tile under the
// mouse / center for debugging the local pyramid.
function lonLatToTile(lon: number, lat: number, z: number): [number, number] {
  const n = Math.pow(2, z);
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  return [x, y];
}

export default function SatelliteTimeMap() {
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoomLevel, setZoomLevel] = useState<number>(ZOOM);
  const [mouseLatLng, setMouseLatLng] = useState<[number, number] | null>(null);
  const [centerLatLng, setCenterLatLng] = useState<[number, number]>(CENTER);
  const [sceneIdx, setSceneIdx] = useState(0);
  const [aisPings, setAisPings] = useState<Array<{
    lat: number; lon: number; time?: string;
    mmsi?: string | number; imo?: string; name?: string; callsign?: string;
    type?: string; flag?: string;
    ageSec?: number; sog?: number; cog?: number; heading?: number;
    length?: number | null; width?: number | null; destination?: string;
  }>>([]);
  const [aisStatus, setAisStatus] = useState<"idle" | "loading" | "ok" | "error" | "missing-token">("idle");
  const [aisError, setAisError] = useState<string | null>(null);
  const [aisVisible, setAisVisible] = useState(true);
  const [detections, setDetections] = useState<Array<{ lat0: number; lon0: number; lat1: number; lon1: number; centerLat: number; centerLon: number; conf: number }>>([]);
  const [detectionsVisible, setDetectionsVisible] = useState(true);
  const deferredPings = useDeferredValue(aisPings);
  const mapRef = useRef<L.Map | null>(null);
  const [shadowOpen, setShadowOpen] = useState(false);

  // Match each YOLO detection to a nearby AIS ping. An AIS ping consumed by
  // one detection is unavailable for further matches (greedy, ordered by
  // detection confidence — strongest detections claim first). Detections
  // that fail to match any ping go red.
  const { unmatchedDet, matchCount, looseMatches } = useMemo(() => {
    // Two-pass greedy match. Pass 1 uses a tight ~150 m bbox pad (AIS antenna
    // vs SAR centroid offset). Pass 2 retries unmatched detections with a
    // 500 m radius to catch heavily offset pings; those are rendered with a
    // white tether line so the operator can see the spatial slack.
    const tightPad = 150;
    const loosePad = 1000;
    const cosLat = Math.cos(58 * Math.PI / 180);
    const available: Array<{ lat: number; lon: number; used: boolean }> =
      aisPings.map((p) => ({ lat: p.lat, lon: p.lon, used: false }));
    const order = detections
      .map((d, i) => ({ d, i }))
      .sort((a, b) => b.d.conf - a.d.conf);

    const claim = (
      d: typeof detections[number],
      padM: number,
    ): { idx: number; lat: number; lon: number } | null => {
      const padLat = padM / 111000;
      const padLon = padM / (111000 * cosLat);
      const x0 = Math.min(d.lon0, d.lon1) - padLon;
      const x1 = Math.max(d.lon0, d.lon1) + padLon;
      const y0 = Math.min(d.lat0, d.lat1) - padLat;
      const y1 = Math.max(d.lat0, d.lat1) + padLat;
      let bestIdx = -1;
      let bestDist = Infinity;
      for (let k = 0; k < available.length; k++) {
        const p = available[k];
        if (p.used) continue;
        if (p.lat < y0 || p.lat > y1 || p.lon < x0 || p.lon > x1) continue;
        const dy = p.lat - d.centerLat;
        const dx = p.lon - d.centerLon;
        const dd = dx * dx + dy * dy;
        if (dd < bestDist) { bestDist = dd; bestIdx = k; }
      }
      if (bestIdx < 0) return null;
      available[bestIdx].used = true;
      return { idx: bestIdx, lat: available[bestIdx].lat, lon: available[bestIdx].lon };
    };

    const unmatched = new Set<number>();
    const pendingLoose: Array<{ d: typeof detections[number]; i: number }> = [];
    let matched = 0;
    for (const item of order) {
      if (claim(item.d, tightPad)) matched++;
      else pendingLoose.push(item);
    }
    const loose: Array<{ i: number; detLat: number; detLon: number; aisLat: number; aisLon: number }> = [];
    for (const { d, i } of pendingLoose) {
      const r = claim(d, loosePad);
      if (r) {
        matched++;
        loose.push({ i, detLat: d.centerLat, detLon: d.centerLon, aisLat: r.lat, aisLon: r.lon });
      } else {
        unmatched.add(i);
      }
    }
    return { unmatchedDet: unmatched, matchCount: matched, looseMatches: loose };
  }, [detections, aisPings]);

  useEffect(() => {
    fetch("/tiles/s1/manifest.json")
      .then((r) => r.ok ? r.json() : Promise.reject(`manifest ${r.status}`))
      .then((m: Manifest) => {
        setManifest(m);
        // Prefer 2025-06-12 if present, else first scene.
        const preferredIdx = m.scenes.findIndex((s) => s.date === "2025-06-12");
        setSceneIdx(preferredIdx >= 0 ? preferredIdx : 0);
      })
      .catch((e) => setError(String(e)));
  }, []);

  const scenes = (manifest?.scenes ?? []).filter((s) => s.date === "2025-06-12");
  const scene = scenes[Math.min(sceneIdx, scenes.length - 1)] ?? null;

  // Fetch AIS overlay for the active scene's acquisition time.
  useEffect(() => {
    if (!scene) return;
    const ctrl = new AbortController();
    setAisStatus("loading");
    setAisError(null);
    setAisPings([]);
    const bbox = scene.bbox.join(",");
    // Local AIS only (DMA daily parquet). GFW fallback removed — its data
    // quality wasn't good enough.
    const params = `datetime=${encodeURIComponent(scene.datetime)}&bbox=${encodeURIComponent(bbox)}&bufferKm=50`;
    fetch(`/api/ais-local?${params}`, { signal: ctrl.signal })
      .then(async (r) => {
        const j = await r.json();
        if (r.status === 404) {
          setAisStatus("error");
          setAisError("no AIS parquet for this date");
          return;
        }
        if (!r.ok) throw new Error(j.error ?? `status ${r.status}`);
        const pings = (j?.pings ?? []).filter((p: any) => typeof p.lat === "number" && typeof p.lon === "number");
        setAisPings(pings);
        setAisStatus("ok");
      })
      .catch((e) => {
        if (e.name === "AbortError") return;
        setAisStatus("error");
        setAisError(String(e.message ?? e));
      });
    return () => ctrl.abort();
  }, [scene?.id, scene?.datetime]);

  // Fetch YOLO detections for the active scene if available.
  useEffect(() => {
    if (!scene) return;
    const ctrl = new AbortController();
    setDetections([]);
    fetch(`/detections/${scene.id}.json`, { signal: ctrl.signal })
      .then((r) => r.ok ? r.json() : Promise.reject(`status ${r.status}`))
      .then((j) => {
        type Det = { lat0: number; lon0: number; lat1: number; lon1: number; centerLat: number; centerLon: number; conf: number };
        const raw: Det[] = (j.detections ?? []).filter((d: Det) => d.conf >= 0.25);
        const area = (d: Det) => Math.abs(d.lon1 - d.lon0) * Math.abs(d.lat1 - d.lat0);
        const kept = raw.filter((d) => {
          const aArea = area(d);
          return !raw.some((o) => {
            if (o === d) return false;
            if (area(o) < 1.5 * aArea) return false;
            const x0 = Math.min(o.lon0, o.lon1), x1 = Math.max(o.lon0, o.lon1);
            const y0 = Math.min(o.lat0, o.lat1), y1 = Math.max(o.lat0, o.lat1);
            return d.centerLon >= x0 && d.centerLon <= x1 && d.centerLat >= y0 && d.centerLat <= y1;
          });
        });
        setDetections(kept);
      })
      .catch(() => {/* no detections file yet — silent */});
    return () => ctrl.abort();
  }, [scene?.id]);

  return (
    <div style={{ background: THEME.bg, color: THEME.text, fontFamily: THEME.fontSans, border: `1px solid ${THEME.border}`, overflow: "hidden", display: "flex", flexDirection: "column" }}>
      <style>{`
        .leaflet-container { font-family: ${THEME.fontSans}; background: #2a2a2a; }
        .leaflet-control-zoom a { background: ${THEME.surface} !important; color: ${THEME.text} !important; border: 1px solid ${THEME.border} !important; display: flex !important; align-items: center !important; justify-content: center !important; line-height: 1 !important; font-family: ${THEME.fontMono} !important; font-size: 16px !important; }
        .leaflet-control-attribution { background: ${THEME.surface}dd !important; color: ${THEME.textMuted} !important; font-size: 9px !important; }
        .basemap-landwhite-seadark { filter: grayscale(1) brightness(0.56) contrast(10.6); }
        .toggle-btn { border: none !important; outline: none !important; box-shadow: none !important; }
        .toggle-btn:focus, .toggle-btn:focus-visible, .toggle-btn:active { border: none !important; outline: none !important; box-shadow: none !important; }
      `}</style>

      <div style={{ padding: "10px 14px", background: THEME.bgGrid, borderBottom: `1px solid ${THEME.border}`, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 8, height: 8, background: THEME.amber, boxShadow: `0 0 8px ${THEME.amber}` }} />
          <div>
            <div style={{ fontSize: 9, color: THEME.textMuted, letterSpacing: 2, fontWeight: 700 }}>SENTINEL-1 GRD · VV · LOCAL TILE PYRAMID</div>
            <div style={{ fontSize: 14, fontWeight: 700, letterSpacing: 0.3, marginTop: 2 }}>
              SKAGEN TSS, DENMARK <span style={{ color: THEME.textMuted, fontWeight: 400 }}>/ {scene?.datetime ? new Date(scene.datetime).toISOString().replace("T", " ").slice(0, 19) + "Z" : "—"}</span>
            </div>
          </div>
        </div>
        <div style={{ fontFamily: THEME.fontMono, fontSize: 10, color: THEME.textSecondary, letterSpacing: 1 }}>
          {scene ? `${scene.platform} · ${scene.mode} · ${scene.orbit} · z${scene.zoomMin}-${scene.zoomMax}` : error ? `ERROR · ${error}` : "LOADING…"}
        </div>
      </div>

      <div style={{ position: "relative", height: 540 }}>
        <MapContainer ref={mapRef} center={CENTER} zoom={ZOOM} minZoom={6} maxZoom={18} preferCanvas style={{ width: "100%", height: "100%", background: "#0a0a0a" }} scrollWheelZoom>
          <TileLayer
            url="https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}.png"
            attribution='&copy; <a href="https://carto.com/attributions">CARTO</a> &copy; OpenStreetMap contributors'
            subdomains="abcd"
            maxZoom={19}
            zIndex={1}
            className="basemap-landwhite-seadark"
          />
          {scene && (
            <TileLayer
              key={scene.id}
              url={scene.tileUrl}
              attribution={`Sentinel-1 GRD · ${scene.id} · Copernicus / ESA via Planetary Computer`}
              minZoom={6}
              minNativeZoom={scene.zoomMin}
              maxNativeZoom={scene.zoomMax}
              maxZoom={18}
              zIndex={10}
            />
          )}
          {aisVisible && deferredPings.map((p, i) => {
            const age = p.ageSec ?? 0;
            // green ≤10 min, cyan ≤1 h, amber ≤6 h, dim grey beyond
            const color = age <= 600 ? THEME.green : age <= 3600 ? THEME.cyan : age <= 21600 ? THEME.amber : THEME.textDim;
            const opacity = age <= 600 ? 0.95 : age <= 3600 ? 0.85 : age <= 21600 ? 0.7 : 0.45;
            const ageLabel = age < 60 ? `${age}s` : age < 3600 ? `${Math.round(age/60)}m` : `${Math.floor(age/3600)}h${String(Math.round((age%3600)/60)).padStart(2,"0")}m`;
            // Non-commercial classes (passenger, pleasure, fishing) shown at half
            // size to keep them visible without distracting from cargo/tankers.
            const t = (p.type ?? "").toLowerCase();
            const small = t.includes("passenger") || t.includes("pleasure") || t.includes("fishing");
            return (
              <Marker key={`${scene?.id}-${i}`} position={[p.lat, p.lon]}
                icon={aisTriIcon(color, small, p.heading ?? p.cog ?? null)}
                opacity={opacity}>
                <Tooltip direction="top" offset={[0, -4]} opacity={1}>
                  <div style={{ fontFamily: THEME.fontMono, fontSize: 10, lineHeight: 1.5, minWidth: 200, color: "#000" }}>
                    <div style={{ fontWeight: 700, fontSize: 12, color: "#000", marginBottom: 4 }}>
                      {(p.name && p.name.trim()) || `MMSI ${p.mmsi ?? "—"}`}
                    </div>
                    <Kv k="MMSI" v={String(p.mmsi ?? "—")} />
                    {p.imo && p.imo !== "Unknown" && <Kv k="IMO" v={String(p.imo)} />}
                    {p.callsign && p.callsign !== "Unknown" && <Kv k="CALLSIGN" v={String(p.callsign)} />}
                    {p.type && <Kv k="TYPE" v={String(p.type)} />}
                    {p.flag && <Kv k="FLAG" v={String(p.flag)} />}
                    {(p.length || p.width) && <Kv k="DIM" v={`${p.length ?? "?"}×${p.width ?? "?"} m`} />}
                    {p.destination && String(p.destination).trim() && <Kv k="DEST" v={String(p.destination).trim()} />}
                    <div style={{ height: 4 }} />
                    <Kv k="POS" v={`${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`} />
                    {p.sog != null && <Kv k="SOG" v={`${p.sog.toFixed(1)} kn`} />}
                    {p.cog != null && <Kv k="COG" v={`${p.cog.toFixed(0)}°`} />}
                    {p.heading != null && Number.isFinite(p.heading) && p.heading < 360 && <Kv k="HDG" v={`${Math.round(p.heading)}°`} />}
                    <div style={{ height: 4 }} />
                    <Kv k="TIME" v={p.time ? p.time.replace("T", " ").slice(0, 19) + "Z" : "—"} />
                    <Kv k="AGE" v={ageLabel} colour={color} />
                  </div>
                </Tooltip>
              </Marker>
            );
          })}
          {detectionsVisible && detections.map((d, i) => {
            const isUnmatched = unmatchedDet.has(i);
            const color = isUnmatched ? THEME.red : THEME.amber;
            return (
              <Rectangle key={`${scene?.id}-det-${i}`}
                bounds={[[d.lat0, d.lon0], [d.lat1, d.lon1]]}
                pathOptions={{ color, weight: isUnmatched ? 2 : 1.5, fillOpacity: 0, opacity: Math.min(1, 0.3 + d.conf) }}>
                <Tooltip direction="top" offset={[0, -4]} opacity={1}>
                  <div style={{ fontFamily: THEME.fontMono, fontSize: 10, color: "#000", lineHeight: 1.5 }}>
                    <div style={{ fontWeight: 700 }}>YOLOv8 detection</div>
                    <Kv k="CONF" v={d.conf.toFixed(2)} />
                    <Kv k="CENTER" v={`${d.centerLat.toFixed(4)}, ${d.centerLon.toFixed(4)}`} />
                    {(() => {
                      const wM = Math.abs(d.lon1 - d.lon0) * 111000 * Math.cos(d.centerLat * Math.PI / 180);
                      const hM = Math.abs(d.lat1 - d.lat0) * 111000;
                      return <Kv k="SIZE" v={`${Math.max(wM, hM).toFixed(0)} × ${Math.min(wM, hM).toFixed(0)} m`} />;
                    })()}
                    <Kv k="AIS" v={isUnmatched ? "no match (dark vessel?)" : "matched"} colour={color} />
                  </div>
                </Tooltip>
              </Rectangle>
            );
          })}
          {detectionsVisible && looseMatches.map((m) => (
            <Polyline key={`${scene?.id}-loose-${m.i}`}
              positions={[[m.detLat, m.detLon], [m.aisLat, m.aisLon]]}
              pathOptions={{ color: "#ffffff", weight: 1, opacity: 0.8 }} />
          ))}
          <MapTracker onZoom={setZoomLevel} onMouse={setMouseLatLng} onCenter={setCenterLatLng} />
        </MapContainer>

        {scene && (
          <div style={{
            position: "absolute", top: 12, right: 12, zIndex: 1000,
            background: `${THEME.surface}ee`, border: `1px solid ${THEME.border}`,
            fontFamily: THEME.fontMono, fontSize: 10, color: THEME.textSecondary,
            letterSpacing: 1, minWidth: 200, maxWidth: 260,
          }}>
            <button
              onClick={() => setShadowOpen((v) => !v)}
              style={{
                width: "100%", padding: "8px 10px", display: "flex",
                alignItems: "center", justifyContent: "space-between", gap: 8,
                background: "transparent", border: 0, color: "inherit",
                fontFamily: "inherit", fontSize: "inherit", letterSpacing: "inherit",
                cursor: unmatchedDet.size ? "pointer" : "default", textAlign: "left",
              }}
              disabled={unmatchedDet.size === 0}
            >
              <div>
                <div style={{ fontSize: 8, color: THEME.textMuted, letterSpacing: 1.5 }}>SHADOW VESSELS</div>
                <div style={{ fontSize: 18, fontWeight: 800, color: unmatchedDet.size ? THEME.red : THEME.text, marginTop: 2, letterSpacing: 0.5 }}>
                  {unmatchedDet.size}
                </div>
              </div>
              {unmatchedDet.size > 0 && (
                <span style={{ color: THEME.textMuted, fontSize: 12, transform: shadowOpen ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}>▸</span>
              )}
            </button>
            {shadowOpen && unmatchedDet.size > 0 && (
              <div style={{ borderTop: `1px solid ${THEME.border}`, maxHeight: 280, overflowY: "auto" }}>
                {detections
                  .map((d, i) => ({ d, i }))
                  .filter(({ i }) => unmatchedDet.has(i))
                  .sort((a, b) => b.d.conf - a.d.conf)
                  .map(({ d, i }) => (
                    <button key={i}
                      onClick={() => {
                        const m = mapRef.current;
                        if (!m) return;
                        const z = Math.max(m.getZoom(), 11);
                        m.setView([d.centerLat, d.centerLon], z);
                      }}
                      style={{
                        width: "100%", padding: "6px 10px", display: "flex",
                        justifyContent: "space-between", alignItems: "center", gap: 8,
                        background: "transparent", border: 0, borderTop: `1px solid ${THEME.border}33`,
                        color: THEME.text, fontFamily: "inherit", fontSize: 10, letterSpacing: 0.5,
                        cursor: "pointer", textAlign: "left",
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = `${THEME.red}22`)}
                      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                    >
                      <span style={{ color: THEME.red, fontWeight: 700 }}>#{i + 1}</span>
                      <span style={{ flex: 1, color: THEME.text, fontVariantNumeric: "tabular-nums", marginLeft: 8 }}>
                        {d.centerLat.toFixed(4)}, {d.centerLon.toFixed(4)}
                      </span>
                      <span style={{ color: THEME.textMuted }}>{d.conf.toFixed(2)}</span>
                    </button>
                  ))}
              </div>
            )}
          </div>
        )}

        <div style={{
          position: "absolute", top: 10, left: 54, zIndex: 1000,
          display: "flex", flexDirection: "column",
          background: `${THEME.surface}ee`, border: `1px solid ${THEME.border}`,
          fontFamily: THEME.fontMono, fontSize: 9, color: THEME.textSecondary,
          letterSpacing: 1,
        }}>
          <button onClick={() => setAisVisible((v) => !v)}
            title={aisVisible ? "hide AIS overlay" : "show AIS overlay"}
            className="toggle-btn"
            style={{
              display: "flex", alignItems: "center", gap: 4, padding: "0 8px 0 0",
              height: 22, background: "transparent",
              color: aisVisible ? THEME.text : THEME.textMuted,
              border: 0, outline: "none", margin: 0, boxShadow: "none", cursor: "pointer",
              fontFamily: "inherit", fontSize: "inherit", letterSpacing: "inherit",
            }}>
            <span style={{ width: 22, height: 22, display: "flex", alignItems: "center", justifyContent: "center" }}>
              {aisVisible ? (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              ) : (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                  <line x1="1" y1="1" x2="23" y2="23" />
                </svg>
              )}
            </span>
            toggle AIS data
          </button>

          <button onClick={() => setDetectionsVisible((v) => !v)}
            title={detectionsVisible ? "hide YOLO detections" : "show YOLO detections"}
            className="toggle-btn"
            style={{
              display: "flex", alignItems: "center", gap: 4, padding: "0 8px 0 0",
              height: 22, background: "transparent",
              color: detectionsVisible ? THEME.text : THEME.textMuted,
              border: 0, outline: "none", margin: 0, boxShadow: "none", cursor: "pointer",
              fontFamily: "inherit", fontSize: "inherit", letterSpacing: "inherit",
            }}>
            <span style={{ width: 22, height: 22, display: "flex", alignItems: "center", justifyContent: "center" }}>
              {detectionsVisible ? (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              ) : (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                  <line x1="1" y1="1" x2="23" y2="23" />
                </svg>
              )}
            </span>
            toggle SAR bboxes
          </button>
        </div>

        <div style={{
          position: "absolute", bottom: 12, left: 12, zIndex: 1000,
          display: "flex", alignItems: "center", gap: 8,
          padding: "6px 10px", background: `${THEME.surface}ee`,
          border: `1px solid ${THEME.border}`,
          fontFamily: THEME.fontMono, fontSize: 11, color: THEME.text,
          letterSpacing: 0.5, fontVariantNumeric: "tabular-nums",
        }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: THEME.textSecondary }}>
            <circle cx="12" cy="12" r="9" />
            <circle cx="12" cy="12" r="3" />
            <line x1="12" y1="1" x2="12" y2="5" />
            <line x1="12" y1="19" x2="12" y2="23" />
            <line x1="1" y1="12" x2="5" y2="12" />
            <line x1="19" y1="12" x2="23" y2="12" />
          </svg>
          {(() => {
            const p = mouseLatLng ?? centerLatLng;
            return <span>{p[0].toFixed(4)}, {p[1].toFixed(4)}</span>;
          })()}
        </div>

      </div>

      {scenes.length > 0 && (
        <div style={{ padding: "10px 14px", background: THEME.bgGrid, borderTop: `1px solid ${THEME.border}` }}>
          <div style={{ fontSize: 9, color: THEME.textMuted, letterSpacing: 2, fontWeight: 700, marginBottom: 8 }}>TIME AXIS · {scenes.length} ACQUISITION{scenes.length === 1 ? "" : "S"}</div>
          <div style={{ position: "relative", display: "flex", alignItems: "stretch", gap: 0, border: `1px solid ${THEME.border}` }}>
            {scenes.map((s, i) => {
              const active = i === sceneIdx;
              return (
                <button key={s.id} onClick={() => startTransition(() => setSceneIdx(i))}
                  style={{
                    flex: 1, padding: "8px 6px", background: active ? THEME.amber : "transparent",
                    color: active ? THEME.bg : THEME.text,
                    border: 0, borderRight: i < scenes.length - 1 ? `1px solid ${THEME.border}` : 0,
                    fontFamily: THEME.fontMono, fontSize: 10, letterSpacing: 1, cursor: "pointer",
                    display: "flex", flexDirection: "column", gap: 2, alignItems: "center",
                  }}>
                  <span style={{ fontWeight: 700 }}>{s.date}</span>
                  <span style={{ fontSize: 9, opacity: 0.7 }}>{new Date(s.datetime).toISOString().slice(11, 16)}Z · {s.orbit?.slice(0, 3).toUpperCase()}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div style={{ padding: "6px 14px", background: THEME.bgGrid, borderTop: `1px solid ${THEME.border}`, fontSize: 9, color: THEME.textMuted, letterSpacing: 1, display: "flex", justifyContent: "space-between", fontFamily: THEME.fontMono }}>
        <span>S1 GRD · VV · dB · LOCAL XYZ PYRAMID · YOLO {matchCount}/{detections.length} matched ({unmatchedDet.size} dark)</span>
        <span>
          AIS · {aisStatus === "ok" ? `${aisPings.length} pings (GFW)` :
            aisStatus === "loading" ? "fetching…" :
            aisStatus === "missing-token" ? "set GFW_TOKEN" :
            aisStatus === "error" ? `error: ${aisError ?? ""}` : "—"}
        </span>
      </div>

      {scene && (() => {
        const probe = mouseLatLng ?? centerLatLng;
        const label = mouseLatLng ? "MOUSE" : "CENTER";
        const z = Math.min(Math.max(zoomLevel, scene.zoomMin), scene.zoomMax);
        const [tx, ty] = lonLatToTile(probe[1], probe[0], z);
        const tileUrl = scene.tileUrl.replace("{z}", String(z)).replace("{x}", String(tx)).replace("{y}", String(ty));
        const Cell = ({ k, v, colour }: { k: string; v: React.ReactNode; colour?: string }) => (
          <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
            <span style={{ fontSize: 8, color: THEME.textMuted, letterSpacing: 1.5 }}>{k}</span>
            <span style={{ color: colour ?? THEME.text, fontSize: 10, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{v}</span>
          </div>
        );
        return (
          <div style={{ padding: "8px 14px", background: THEME.bgGrid, borderTop: `1px solid ${THEME.border}`, fontFamily: THEME.fontMono, letterSpacing: 1 }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: "8px 16px" }}>
              <Cell k="ITEM" v={`${scene.id.slice(0, 16)}…`} />
              <Cell k="TIME" v={`${new Date(scene.datetime).toISOString().slice(11, 19)}Z`} />
              <Cell k="ORBIT" v={scene.orbit} />
              <Cell k="POL" v={scene.polarization} />
              <Cell k="RESCALE" v={`${scene.rescaleDb[0]}…${scene.rescaleDb[1]} dB`} />
              <Cell k="ZOOMS" v={`${scene.zoomMin}-${scene.zoomMax}`} />
              <Cell k="CURRENT Z" v={`z${zoomLevel}${zoomLevel > scene.zoomMax ? " (upscaled)" : ""}`} colour={zoomLevel > scene.zoomMax ? THEME.amber : THEME.text} />
              <Cell k={label} v={`${probe[0].toFixed(4)}, ${probe[1].toFixed(4)}`} />
              <Cell k={`TILE @ z${z}`} v={`${tx}/${ty}`} />
            </div>
            <div style={{ marginTop: 6, fontSize: 9, color: THEME.textMuted, wordBreak: "break-all" }}>{tileUrl}</div>
          </div>
        );
      })()}
    </div>
  );
}
