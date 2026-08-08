"use client";

import { useMemo } from "react";

/** Escape regex special chars in a literal keyword. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type Part = { text: string; hit: boolean };

function splitHighlighted(
  text: string,
  keywords: string[],
  loose = false,
): Part[] {
  const terms = [...new Set(keywords.map((k) => k.trim()).filter(Boolean))].sort(
    (a, b) => b.length - a.length,
  );
  if (!text || terms.length === 0) return [{ text, hit: false }];

  const body = terms
    .map((t) => escapeRegExp(t).replace(/\\s+/g, "\\s+"))
    .join("|");
  const re = new RegExp(loose ? `(${body})` : `\\b(${body})\\b`, "gi");
  const parts: Part[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      parts.push({ text: text.slice(last, m.index), hit: false });
    }
    parts.push({ text: m[0], hit: true });
    last = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex += 1;
  }
  if (last < text.length) parts.push({ text: text.slice(last), hit: false });
  return parts.length ? parts : [{ text, hit: false }];
}

type Props = {
  text: string;
  keywords?: string[];
  className?: string;
  /** Substring match (for tickers like TATAINVEST). Default: whole-word. */
  loose?: boolean;
};

export function HighlightedText({
  text,
  keywords = [],
  className,
  loose = false,
}: Props) {
  const parts = useMemo(
    () => splitHighlighted(text, keywords, loose),
    [text, keywords, loose],
  );

  if (!text) return null;

  return (
    <span className={className}>
      {parts.map((p, i) =>
        p.hit ? (
          <mark key={i} className="kw-hit">
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </span>
  );
}
