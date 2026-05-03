import React, { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
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

function MapTracker({ onMouse, onCenter }: {
  onMouse: (latLng: [number, number] | null) => void;
  onCenter: (latLng: [number, number]) => void;
}) {
  const map = useMapEvents({
    zoomend: () => onCenter([map.getCenter().lat, map.getCenter().lng]),
    moveend: () => onCenter([map.getCenter().lat, map.getCenter().lng]),
    mousemove: (e) => onMouse([e.latlng.lat, e.latlng.lng]),
    mouseout: () => onMouse(null),
  });
  useEffect(() => {
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

export default function SatelliteTimeMap() {
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [error, setError] = useState<string | null>(null);
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
  const [aisStatus, setAisStatus] = useState<"idle" | "loading" | "ok" | "error">("idle");
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
    <div style={{ background: THEME.surface, color: THEME.text, fontFamily: THEME.fontMono, border: `1px solid ${THEME.border}`, borderRadius: 8, overflow: "hidden", display: "flex", flexDirection: "column", boxShadow: THEME.shadow }}>
      <style>{`
        .leaflet-container { font-family: ${THEME.fontMono}; background: #2a2a2a; }
        .leaflet-control-zoom { display: none !important; }
        .leaflet-control-zoom a { background: ${THEME.surface} !important; color: ${THEME.text} !important; border: 0 !important; display: flex !important; align-items: center !important; justify-content: center !important; line-height: 1 !important; font-family: ${THEME.fontMono} !important; font-size: 16px !important; }
        .leaflet-control-zoom a + a { border-top: 1px solid ${THEME.border} !important; }
        .leaflet-control-attribution { background: ${THEME.surface}dd !important; color: ${THEME.textMuted} !important; font-size: 9px !important; }
        .basemap-landwhite-seadark { filter: grayscale(1) brightness(0.56) contrast(10.6); }
        .toggle-btn { border: none !important; outline: none !important; box-shadow: none !important; }
        .toggle-btn:focus, .toggle-btn:focus-visible, .toggle-btn:active { border: none !important; outline: none !important; box-shadow: none !important; }
      `}</style>

      <div style={{ padding: "14px 16px", background: THEME.surfaceElevated, borderBottom: `1px solid ${THEME.border}`, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
          <div style={{ width: 10, height: 10, borderRadius: 999, background: scene ? THEME.green : THEME.amber, boxShadow: `0 0 16px ${scene ? THEME.green : THEME.amber}` }} />
          <div>
            <div style={{ fontSize: 10, color: THEME.textMuted, fontWeight: 700, letterSpacing: 1.4, fontFamily: THEME.fontMono, textTransform: "uppercase" }}>Scene</div>
            <div style={{ fontSize: 15, fontWeight: 800, letterSpacing: 0.7, marginTop: 2, fontFamily: THEME.fontMono, textTransform: "uppercase" }}>
              Skagen TSS, Denmark
            </div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", justifyContent: "flex-end", fontFamily: THEME.fontMono }}>
          <div style={{
            padding: "8px 11px",
            background: THEME.surface,
            border: `1px solid ${THEME.border}`,
            borderRadius: 7,
            color: THEME.text,
            fontSize: 12,
            letterSpacing: 0.6,
            fontVariantNumeric: "tabular-nums",
          }}>
            {scene?.datetime ? new Date(scene.datetime).toISOString().replace("T", " ").slice(0, 16) + "Z" : "Loading scene"}
          </div>
          {error && <span style={{ color: THEME.red, fontSize: 12 }}>{error}</span>}
        </div>
      </div>

      <div style={{ position: "relative", height: 540 }}>
        <MapContainer ref={mapRef} center={CENTER} zoom={ZOOM} minZoom={6} maxZoom={18} zoomControl={false} preferCanvas style={{ width: "100%", height: "100%", background: "#0a0a0a" }} scrollWheelZoom>
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
            // green ≤10 min, darker green ≤1 h, amber ≤6 h, dim grey beyond
            const color = age <= 600 ? THEME.green : age <= 3600 ? THEME.greenDark : age <= 21600 ? THEME.amber : THEME.textDim;
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
          <MapTracker onMouse={setMouseLatLng} onCenter={setCenterLatLng} />
        </MapContainer>

        {scene && (
          <div style={{
            position: "absolute", top: 12, right: 12, zIndex: 1000,
            background: `${THEME.surface}f2`, border: `1px solid ${THEME.border}`,
            fontSize: 11, color: THEME.textSecondary,
            width: 238, borderRadius: 8, overflow: "hidden",
            boxShadow: THEME.shadow,
          }}>
            <button
              onClick={() => setShadowOpen((v) => !v)}
              style={{
                width: "100%", padding: "11px 12px", display: "flex",
                alignItems: "center", justifyContent: "space-between", gap: 12,
                background: shadowOpen ? THEME.surfaceElevated : "transparent", border: 0, color: "inherit",
                fontFamily: "inherit", fontSize: "inherit",
                cursor: "pointer", textAlign: "left",
              }}
              aria-expanded={shadowOpen}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 11, minWidth: 0 }}>
                <div style={{
                  width: 42,
                  height: 42,
                  borderRadius: 7,
                  border: `1px solid ${unmatchedDet.size ? THEME.red : THEME.borderBright}`,
                  background: unmatchedDet.size ? `${THEME.red}18` : THEME.surface,
                  color: unmatchedDet.size ? THEME.redBright : THEME.textMuted,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 20,
                  fontWeight: 850,
                  fontFamily: THEME.fontMono,
                  fontVariantNumeric: "tabular-nums",
                  lineHeight: 1,
                }}>
                  {unmatchedDet.size}
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 11, color: THEME.text, fontWeight: 800, letterSpacing: 0.9, textTransform: "uppercase", fontFamily: THEME.fontMono }}>Dark candidates</div>
                  <div style={{ marginTop: 3, fontSize: 10, color: unmatchedDet.size ? THEME.redBright : THEME.textMuted, fontFamily: THEME.fontMono, letterSpacing: 0.5 }}>
                    {unmatchedDet.size ? "Highly suspicious vessel" : "No unmatched SAR returns"}
                  </div>
                </div>
              </div>
              <span style={{
                width: 24,
                height: 24,
                borderRadius: 6,
                border: `1px solid ${THEME.border}`,
                color: THEME.textMuted,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                transform: shadowOpen ? "rotate(180deg)" : "none",
                transition: "transform 0.15s",
                flex: "0 0 auto",
              }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </span>
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
                        width: "100%", padding: "9px 12px", display: "flex",
                        justifyContent: "space-between", alignItems: "center", gap: 8,
                        background: "transparent", border: 0, borderTop: `1px solid ${THEME.borderSoft}`,
                        color: THEME.text, fontFamily: THEME.fontMono, fontSize: 11, letterSpacing: 0.3,
                        cursor: "pointer", textAlign: "left",
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = `${THEME.red}22`)}
                      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                    >
                      <span style={{ color: THEME.redBright, fontWeight: 800 }}>#{i + 1}</span>
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
          position: "absolute", top: 12, left: 12, zIndex: 1000,
          display: "flex", flexDirection: "column", gap: 2,
          background: `${THEME.surface}f2`, border: `1px solid ${THEME.border}`,
          fontSize: 11, color: THEME.textSecondary, fontFamily: THEME.fontMono, letterSpacing: 0.8,
          borderRadius: 8, padding: 3, boxShadow: THEME.shadow,
        }}>
          <button onClick={() => setAisVisible((v) => !v)}
            title={aisVisible ? "hide AIS overlay" : "show AIS overlay"}
            className="toggle-btn"
            style={{
              display: "flex", alignItems: "center", gap: 6, padding: "0 9px 0 0",
              height: 28, background: aisVisible ? THEME.surfaceElevated : "transparent",
              color: aisVisible ? THEME.text : THEME.textMuted,
              border: 0, outline: "none", margin: 0, boxShadow: "none", cursor: "pointer",
              borderRadius: 6, fontFamily: "inherit", fontSize: "inherit",
            }}>
            <span style={{ width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center" }}>
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
            AIS
          </button>

          <button onClick={() => setDetectionsVisible((v) => !v)}
            title={detectionsVisible ? "hide YOLO detections" : "show YOLO detections"}
            className="toggle-btn"
            style={{
              display: "flex", alignItems: "center", gap: 6, padding: "0 9px 0 0",
              height: 28, background: detectionsVisible ? THEME.surfaceElevated : "transparent",
              color: detectionsVisible ? THEME.text : THEME.textMuted,
              border: 0, outline: "none", margin: 0, boxShadow: "none", cursor: "pointer",
              borderRadius: 6, fontFamily: "inherit", fontSize: "inherit",
            }}>
            <span style={{ width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center" }}>
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
            SAR
          </button>
        </div>

        <div style={{
          position: "absolute", bottom: 12, left: 12, zIndex: 1000,
          display: "flex", alignItems: "center", gap: 8,
          padding: "7px 10px", background: `${THEME.surface}e8`,
          border: `1px solid ${THEME.border}`, borderRadius: 8,
          fontFamily: THEME.fontMono, fontSize: 11, color: THEME.textMuted,
          fontVariantNumeric: "tabular-nums", boxShadow: THEME.shadow,
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

    </div>
  );
}
