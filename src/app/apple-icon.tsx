import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

/** Apple touch icon — Edge/Lotusdew-style lime→teal mark. */
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
          background: "linear-gradient(135deg, #c6f06c, #3dd6c6)",
          color: "#102016",
          borderRadius: 40,
          fontSize: 92,
          fontWeight: 500,
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          letterSpacing: "0.06em",
        }}
      >
        R
      </div>
    ),
    { ...size },
  );
}
