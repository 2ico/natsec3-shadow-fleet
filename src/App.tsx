import React from "react";
import SatelliteTimeMap from "./SatelliteTimeMap";
import { THEME } from "./theme";

function Legend() {
  const Row = ({ swatch, label, sub }: { swatch: React.ReactNode; label: string; sub?: string }) => (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0", borderBottom: `1px solid ${THEME.border}` }}>
      <div style={{ width: 22, display: "flex", justifyContent: "center" }}>{swatch}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 11, color: THEME.text, fontWeight: 600 }}>{label}</div>
        {sub && <div style={{ fontSize: 9, color: THEME.textMuted, fontFamily: THEME.fontMono, letterSpacing: 0.5, marginTop: 1 }}>{sub}</div>}
      </div>
    </div>
  );
  const Dot = ({ color, small }: { color: string; small?: boolean }) => {
    const len = small ? 9 : 14;
    const halfBase = len * Math.tan((15 / 2) * Math.PI / 180);
    const pad = 2;
    const box = Math.ceil(len + pad * 2);
    const cx = box / 2, cy = box / 2;
    return (
      <svg width={box} height={box} viewBox={`0 0 ${box} ${box}`} style={{ display: "block", filter: `drop-shadow(0 0 2px ${color}cc)` }}>
        <polygon
          points={`${cx},${cy - len / 2} ${cx - halfBase},${cy + len / 2} ${cx + halfBase},${cy + len / 2}`}
          fill={`${color}33`} stroke={color} strokeWidth={small ? 1.1 : 1.4} strokeLinejoin="round"
        />
      </svg>
    );
  };
  return (
    <div style={{ height: "100%", overflowY: "auto", padding: "12px 14px", background: THEME.surface, border: `1px solid ${THEME.border}`, fontFamily: THEME.fontSans, color: THEME.text }}>
      <div style={{ fontSize: 9, color: THEME.textMuted, letterSpacing: 2, fontWeight: 700, marginBottom: 4 }}>LEGEND</div>
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 12 }}>Map symbology</div>

      <div style={{ fontSize: 10, color: THEME.textSecondary, letterSpacing: 1.5, fontWeight: 700, margin: "8px 0 4px" }}>
        AIS · vessel positions
      </div>
      <Row swatch={<Dot color={THEME.green} />} label="Fresh" sub="≤ 10 minutes old" />
      <Row swatch={<Dot color={THEME.cyan} />} label="Recent" sub="≤ 1 hour old" />
      <Row swatch={<Dot color={THEME.amber} />} label="Stale" sub="≤ 6 hours old" />
      <Row swatch={<Dot color={THEME.textDim} />} label="Historical" sub="6 – 24 hours old" />

      <div style={{ height: 8 }} />
      <Row swatch={<Dot color={THEME.cyan} />} label="Cargo / Tanker / other" sub="full-size ✕" />
      <Row swatch={<Dot color={THEME.cyan} small />} label="Passenger / Pleasure / Fishing" sub="half-size ✕" />

      <div style={{ fontSize: 10, color: THEME.textSecondary, letterSpacing: 1.5, fontWeight: 700, margin: "16px 0 4px" }}>
        SAR · YOLO ship detections
      </div>
      <Row
        swatch={<div style={{ width: 18, height: 12, border: `1.5px solid ${THEME.amber}`, background: "transparent" }} />}
        label="Detected vessel"
        sub="bbox from MeWan2808/yolov8n-sar-vessel-detection"
      />

      <div style={{ fontSize: 10, color: THEME.textSecondary, letterSpacing: 1.5, fontWeight: 700, margin: "16px 0 4px" }}>
        Notes
      </div>
      <div style={{ fontSize: 10, color: THEME.textMuted, lineHeight: 1.6, fontFamily: THEME.fontMono }}>
        AIS pings filtered to ±5 min window around the SAR acquisition (per-MMSI most-recent within 24 h lookback). YOLO detections rejected when ≥10% of the bbox falls on the OpenStreetMap coastline to suppress land returns.
      </div>
    </div>
  );
}

export default function App() {
  return (
    <div style={{
      minHeight: "100vh", background: THEME.bg, color: THEME.text,
      fontFamily: THEME.fontSans,
      display: "grid", gridTemplateColumns: "1fr 280px", gap: 12, padding: 12,
    }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
        <div style={{
          padding: "10px 14px", background: THEME.bgGrid,
          border: `1px solid ${THEME.border}`,
          display: "flex", alignItems: "center", justifyContent: "space-between",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ fontSize: 16, fontWeight: 800, letterSpacing: 2, color: THEME.amber }}>SHADOW FLEET DETECTOR</div>
            <div style={{ fontSize: 10, color: THEME.textMuted, fontFamily: THEME.fontMono, letterSpacing: 1.5 }}>
              MULTI-INT FUSION · SAR + AIS
            </div>
          </div>
          <span style={{ fontSize: 9, color: THEME.textDim, fontFamily: THEME.fontMono, letterSpacing: 2 }}>UNCLASS · OPEN-SOURCE</span>
        </div>

        <SatelliteTimeMap />
      </div>

      <div style={{ height: "calc(100vh - 24px)", position: "sticky", top: 12 }}>
        <Legend />
      </div>
    </div>
  );
}
