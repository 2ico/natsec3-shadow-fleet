export const THEME = {
  bg: "#000000",
  bgGrid: "#0a0a0a",
  surface: "#141414",
  surfaceElevated: "#1c1c1c",
  surfaceHi: "#262626",
  border: "#2e2e2e",
  borderBright: "#3d3d3d",
  borderAccent: "#4d4d4d",

  text: "#ececec",
  textSecondary: "#a8a8a8",
  textMuted: "#777777",
  textDim: "#525252",

  amber: "#f59e0b",
  amberBright: "#fbbf24",
  cyan: "#22d3ee",
  cyanBright: "#67e8f9",
  red: "#ef4444",
  redBright: "#f87171",
  orange: "#f97316",
  green: "#22c55e",
  purple: "#a855f7",

  fontMono: `"Berkeley Mono","JetBrains Mono","IBM Plex Mono","SF Mono",ui-monospace,monospace`,
  fontSans: `"Inter","Söhne","SF Pro Text",ui-sans-serif,system-ui,-apple-system,sans-serif`,
} as const;

export const ALERT_COLORS: Record<string, string> = {
  RED: THEME.red,
  ORANGE: THEME.orange,
  YELLOW: THEME.amber,
  GREEN: THEME.green,
};

export const SHIP_TYPE_COLORS: Record<string, string> = {
  Tanker: "#ef4444",
  Cargo: "#22d3ee",
  Passenger: "#a855f7",
  Tug: "#f59e0b",
  Fishing: "#22c55e",
  Pleasure: "#60a5fa",
  "High-speed": "#fbbf24",
  Yacht: "#14b8a6",
  Special: "#c084fc",
  Unknown: "#6b7284",
};

export const COUNTRY_COLORS: Record<string, string> = {
  ARE: "#22d3ee",
  IRN: "#ef4444",
  OMN: "#f97316",
  QAT: "#a855f7",
  BHR: "#f59e0b",
  KWT: "#60a5fa",
  SAU: "#22c55e",
};

export const DARK_TILE_URL =
  "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png";
export const DARK_TILE_ATTR =
  "&copy; OpenStreetMap &copy; CARTO";
