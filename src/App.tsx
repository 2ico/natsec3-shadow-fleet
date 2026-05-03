import React from "react";
import SatelliteTimeMap from "./SatelliteTimeMap";
import { THEME } from "./theme";

function Legend() {
  const Row = ({ swatch, label, sub }: { swatch: React.ReactNode; label: string; sub?: string }) => (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: `1px solid ${THEME.borderSoft}` }}>
      <div style={{ width: 22, display: "flex", justifyContent: "center" }}>{swatch}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, color: THEME.text, fontWeight: 700, fontFamily: THEME.fontMono, letterSpacing: 0.7, textTransform: "uppercase" }}>{label}</div>
        {sub && <div style={{ fontSize: 10, color: THEME.textMuted, marginTop: 2, fontFamily: THEME.fontMono, letterSpacing: 0.5 }}>{sub}</div>}
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
    <div style={{ height: "100%", overflowY: "auto", padding: "18px", background: THEME.surface, border: `1px solid ${THEME.border}`, borderRadius: 8, fontFamily: THEME.fontSans, color: THEME.text, boxShadow: THEME.shadow }}>
      <div style={{ fontSize: 10, color: THEME.textMuted, letterSpacing: 1.6, fontWeight: 750, marginBottom: 4, fontFamily: THEME.fontMono }}>LAYERS</div>
      <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 14, fontFamily: THEME.fontMono, letterSpacing: 0.8, textTransform: "uppercase" }}>Operational view</div>

      <div style={{ fontSize: 11, color: THEME.textSecondary, fontWeight: 750, margin: "8px 0 4px", fontFamily: THEME.fontMono, letterSpacing: 0.8, textTransform: "uppercase" }}>
        AIS positions
      </div>
      <Row swatch={<Dot color={THEME.green} />} label="Fresh" sub="≤ 10 minutes old" />
      <Row swatch={<Dot color={THEME.greenDark} />} label="Recent" sub="≤ 1 hour old" />
      <Row swatch={<Dot color={THEME.amber} />} label="Stale" sub="≤ 6 hours old" />
      <Row swatch={<Dot color={THEME.textDim} />} label="Historical" sub="6 – 24 hours old" />

      <div style={{ height: 8 }} />
      <Row swatch={<Dot color={THEME.cyan} />} label="Commercial vessel" sub="full-size marker" />
      <Row swatch={<Dot color={THEME.cyan} small />} label="Small / fishing vessel" sub="compact marker" />

      <div style={{ fontSize: 11, color: THEME.textSecondary, fontWeight: 750, margin: "18px 0 4px", fontFamily: THEME.fontMono, letterSpacing: 0.8, textTransform: "uppercase" }}>
        SAR detections
      </div>
      <Row
        swatch={<div style={{ width: 18, height: 12, border: `1.5px solid ${THEME.amber}`, background: "transparent", borderRadius: 2 }} />}
        label="Matched vessel"
        sub="SAR bbox with AIS nearby"
      />
      <Row
        swatch={<div style={{ width: 18, height: 12, border: `1.5px solid ${THEME.red}`, background: `${THEME.red}18`, borderRadius: 2 }} />}
        label="Dark candidate"
        sub="no AIS match near SAR return"
      />
    </div>
  );
}

export default function App() {
  return (
    <div style={{
      minHeight: "100vh", background: THEME.bg, color: THEME.text,
      fontFamily: THEME.fontMono,
      display: "grid", gridTemplateColumns: "minmax(0, 1fr) 284px", gap: 16, padding: 16,
    }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
        <div style={{
          padding: "14px 18px", background: THEME.surface,
          border: `1px solid ${THEME.border}`, borderRadius: 8,
          display: "flex", alignItems: "center", justifyContent: "space-between",
          boxShadow: THEME.shadow,
        }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 12, minWidth: 0 }}>
            <div style={{ fontSize: 18, fontWeight: 850, letterSpacing: 1.4, color: THEME.green, fontFamily: THEME.fontMono, textTransform: "uppercase" }}>Shadow Fleet Detector</div>
            <div style={{ fontSize: 11, color: THEME.textMuted, letterSpacing: 1.2, fontWeight: 700, fontFamily: THEME.fontMono }}>
              MULTI-INT FUSION · SAR + AIS
            </div>
          </div>
          <span style={{ fontSize: 11, color: THEME.textMuted, letterSpacing: 0.8, fontWeight: 650, textTransform: "uppercase" }}>Open-source maritime intelligence</span>
        </div>

        <SatelliteTimeMap />
      </div>

      <div style={{ height: "calc(100vh - 32px)", position: "sticky", top: 16 }}>
        <Legend />
      </div>
    </div>
  );
}
