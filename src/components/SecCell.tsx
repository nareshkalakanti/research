"use client";

export function secDisplay(
  sector: string | null | undefined,
  sub: string | null | undefined,
): {
  primary: string;
  secondary: string | null;
  title: string | undefined;
} {
  const s = (sector || "").trim();
  const u = (sub || "").trim();
  const title = [s, u].filter(Boolean).join(" · ") || undefined;
  if (!s && !u) return { primary: "—", secondary: null, title: undefined };
  if (s && u && s.toLowerCase() !== u.toLowerCase()) {
    return { primary: s, secondary: u, title };
  }
  return { primary: u || s, secondary: null, title };
}

export function SecCell({
  sector,
  subSector,
  className = "cd-sec",
}: {
  sector: string | null | undefined;
  subSector: string | null | undefined;
  className?: string;
}) {
  const sec = secDisplay(sector, subSector);
  return (
    <td className={className} title={sec.title}>
      <span className="cd-sec-primary">{sec.primary}</span>
      {sec.secondary ? (
        <span className="cd-sec-secondary">{sec.secondary}</span>
      ) : null}
    </td>
  );
}
