import { ImageResponse } from "next/og";

export const size = { width: 32, height: 32 };
export const contentType = "image/png";

/** Tab favicon — white tile + R. */
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
          background: "#ffffff",
          borderRadius: 8,
          border: "1px solid #e4e7ec",
          color: "#0f172a",
          fontSize: 20,
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
