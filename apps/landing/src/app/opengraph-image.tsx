import { ImageResponse } from "next/og";

export const dynamic = "force-static";
export const alt = "Horos — the only-tighten safety layer for agent payments";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#161c21",
          color: "#e4e1d8",
          padding: "72px 80px",
          fontFamily: "serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <svg width="40" height="56" viewBox="0 0 20 28">
            <path d="M3 27V6.5C3 3.5 6 1 10 1s7 2.5 7 5.5V27" fill="none" stroke="#e4e1d8" strokeWidth="1.8" />
            <path d="M1 27h18" stroke="#e4e1d8" strokeWidth="1.8" />
            <path d="M6 14h8" stroke="#7cc2a6" strokeWidth="2.2" />
          </svg>
          <div style={{ fontSize: 44 }}>Horos</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ fontSize: 68, lineHeight: 1.08, maxWidth: 980 }}>
            Your agent pays without asking you. It never pays past the line.
          </div>
          <div style={{ display: "flex", marginTop: 36, height: 3, width: 1040, background: "#4a5963" }} />
          <div style={{ marginTop: 28, fontSize: 28, color: "#9aa6ad", fontFamily: "sans-serif" }}>
            The only-tighten safety layer for agents that pay in USDC
          </div>
        </div>
      </div>
    ),
    size,
  );
}
