/** App icon — abstract lotus bloom (generic mark, not issuer-specific). */
export function BrandMark({ large = false }: { large?: boolean }) {
  return (
    <span
      className={`brand-mark${large ? " lg" : ""}`}
      aria-hidden
    >
      <svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
        <ellipse
          cx="16"
          cy="13.5"
          rx="3.6"
          ry="7.2"
          fill="currentColor"
        />
        <ellipse
          cx="10.2"
          cy="15.8"
          rx="3.4"
          ry="6.4"
          fill="currentColor"
          opacity="0.88"
          transform="rotate(-28 10.2 15.8)"
        />
        <ellipse
          cx="21.8"
          cy="15.8"
          rx="3.4"
          ry="6.4"
          fill="currentColor"
          opacity="0.88"
          transform="rotate(28 21.8 15.8)"
        />
        <path
          d="M16 21.5c-2.8 1.2-4.8 3.2-5.6 5.8 1.8-0.4 3.6-1.2 5.6-2.4 2 1.2 3.8 2 5.6 2.4-0.8-2.6-2.8-4.6-5.6-5.8Z"
          fill="currentColor"
          opacity="0.72"
        />
      </svg>
    </span>
  );
}
