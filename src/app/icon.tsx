import { ImageResponse } from "next/og";

export const size = { width: 32, height: 32 };
export const contentType = "image/png";

/** Tab icon — Edge/Lotusdew-style lime→teal mark. */
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
          background: "linear-gradient(135deg, #c6f06c, #3dd6c6)",
          color: "#102016",
          borderRadius: 8,
          fontSize: 16,
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
