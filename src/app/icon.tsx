import { ImageResponse } from "next/og";

export const size = { width: 32, height: 32 };
export const contentType = "image/png";

/** Tab / bookmark icon — dark square “R” (not the Next.js N). */
export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#101828",
          color: "#ffffff",
          borderRadius: 8,
          fontSize: 18,
          fontWeight: 700,
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
          letterSpacing: "-0.04em",
        }}
      >
        R
      </div>
    ),
    { ...size },
  );
}
