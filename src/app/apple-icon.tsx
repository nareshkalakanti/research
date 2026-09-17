import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

/** Apple touch icon — white tile + R. */
export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#ffffff",
          borderRadius: 40,
          border: "4px solid #e4e7ec",
          color: "#0f172a",
          fontSize: 108,
          fontWeight: 700,
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
          lineHeight: 1,
        }}
      >
        R
      </div>
    ),
    { ...size },
  );
}
