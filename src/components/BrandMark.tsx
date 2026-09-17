/** App icon — letter R. */
export function BrandMark({ large = false }: { large?: boolean }) {
  return (
    <span className={`brand-mark${large ? " lg" : ""}`} aria-hidden>
      R
    </span>
  );
}
