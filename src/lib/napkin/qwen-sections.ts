export type NapkinQwenSection = { heading: string; body: string };

const DRIVER = ["GROWTH DRIVERS"];
const TRACK = ["MANAGEMENT TRACK RECORD"];
const RISKS = ["RISKS"];
const SCENARIO = ["BEAR CASE", "BASE CASE", "BULL CASE"];
const ASSESS = ["NAPKIN ASSESSMENT", "SOURCE EVIDENCE"];

function norm(h: string): string {
  return h.replace(/^#+\s*/, "").trim().toUpperCase();
}

export function qwenSection(
  sections: NapkinQwenSection[],
  names: string[],
): NapkinQwenSection | null {
  const want = new Set(names.map((n) => n.toUpperCase()));
  return sections.find((s) => want.has(norm(s.heading))) || null;
}

export function groupQwenSections(sections: NapkinQwenSection[]): Array<{
  title: string;
  items: NapkinQwenSection[];
}> {
  const used = new Set<string>();
  const pick = (names: string[]) => {
    const items = names
      .map((n) => qwenSection(sections, [n]))
      .filter((s): s is NapkinQwenSection => Boolean(s));
    for (const s of items) used.add(norm(s.heading));
    return items;
  };
  const groups = [
    { title: "Growth Drivers", items: pick(DRIVER) },
    { title: "Management Track Record", items: pick(TRACK) },
    { title: "Risks", items: pick(RISKS) },
    { title: "Bear / Base / Bull", items: pick(SCENARIO) },
    { title: "Napkin Assessment", items: pick(ASSESS) },
  ];
  const rest = sections.filter((s) => !used.has(norm(s.heading)));
  if (rest.length) groups.push({ title: "Other", items: rest });
  return groups.filter((g) => g.items.length);
}

/** First percent on a CAGR/EPS line in BASE CASE. Fraction if already 0–1.5. */
export function parseQwenBaseCagr(body: string | null | undefined): number | null {
  if (!body) return null;
  const lines = body.split(/\n/);
  const candidates = lines.filter((l) => /cagr|eps/i.test(l));
  const scan = candidates.length ? candidates : lines;
  for (const line of scan) {
    const m = line.match(/(-?\d+(?:\.\d+)?)\s*%/);
    if (!m) continue;
    const n = Number(m[1]);
    if (!Number.isFinite(n)) continue;
    return n / 100;
  }
  const frac = body.match(/(-?\d+(?:\.\d+)?)\s*(?:eps\s*)?cagr/i);
  if (frac) {
    const n = Number(frac[1]);
    if (Number.isFinite(n) && n > -1.5 && n < 1.5) return n;
  }
  return null;
}
