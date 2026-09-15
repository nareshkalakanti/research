import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

/** Apple touch icon — white tile + dark navy lotus (matches header BrandMark). */
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
        }}
      >
        <svg
          width="112"
          height="112"
          viewBox="0 0 32 32"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <ellipse cx="16" cy="13.5" rx="3.6" ry="7.2" fill="#0f172a" />
          <ellipse
            cx="10.2"
            cy="15.8"
            rx="3.4"
            ry="6.4"
            fill="#0f172a"
            opacity="0.88"
            transform="rotate(-28 10.2 15.8)"
          />
          <ellipse
            cx="21.8"
            cy="15.8"
            rx="3.4"
            ry="6.4"
            fill="#0f172a"
            opacity="0.88"
            transform="rotate(28 21.8 15.8)"
          />
          <path
            d="M16 21.5c-2.8 1.2-4.8 3.2-5.6 5.8 1.8-0.4 3.6-1.2 5.6-2.4 2 1.2 3.8 2 5.6 2.4-0.8-2.6-2.8-4.6-5.6-5.8Z"
            fill="#0f172a"
            opacity="0.72"
          />
        </svg>
      </div>
    ),
    { ...size },
  );
}
