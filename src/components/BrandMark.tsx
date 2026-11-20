/**
 * App mark — fleury-cross emblem (Lotusdew logo mark) beside
 * “Research / India equities” in the top bar and on login.
 */
export function BrandMark({ large = false }: { large?: boolean }) {
  return (
    <span className={`brand-mark${large ? " lg" : ""}`} aria-hidden>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        className="brand-mark-glyph"
        src="/brand-mark.png"
        alt=""
        width={large ? 36 : 26}
        height={large ? 36 : 26}
        draggable={false}
      />
    </span>
  );
}
