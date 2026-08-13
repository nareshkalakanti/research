"use client";

import { useMemo } from "react";
import { keywordExplanation } from "@/lib/keyword-glossary";

/** Escape regex special chars in a literal keyword. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Short uppercase tokens → case-sensitive (LED ≠ led in "AI-led"). */
function isAcronymTerm(term: string): boolean {
  return /^[A-Z0-9][A-Z0-9.&/-]{1,7}$/.test(term.trim());
}

type Part = { text: string; hit: boolean; tip: string | null };

function splitHighlighted(
  text: string,
  keywords: string[],
  loose = false,
): Part[] {
  const terms = [...new Set(keywords.map((k) => k.trim()).filter(Boolean))].sort(
    (a, b) => b.length - a.length,
  );
  if (!text || terms.length === 0) return [{ text, hit: false, tip: null }];

  // Acronyms stay case-sensitive; other terms use one case-insensitive pass.
  const acronyms = terms.filter(isAcronymTerm);
  const plain = terms.filter((t) => !isAcronymTerm(t));

  const parts: Part[] = [];
  const hits: { start: number; end: number; tip: string | null }[] = [];

  const collect = (re: RegExp) => {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      // Skip hyphen compounds: "AI-led" should not highlight LED/led
      if (!loose && m.index > 0 && text[m.index - 1] === "-") {
        if (m[0].length === 0) re.lastIndex += 1;
        continue;
      }
      hits.push({
        start: m.index,
        end: m.index + m[0].length,
        tip: keywordExplanation(m[0]),
      });
      if (m[0].length === 0) re.lastIndex += 1;
    }
  };

  if (acronyms.length) {
    const body = acronyms
      .map((t) => escapeRegExp(t).replace(/\\s+/g, "\\s+"))
      .join("|");
    collect(new RegExp(loose ? `(${body})` : `\\b(${body})\\b`, "g"));
  }
  if (plain.length) {
    const body = plain
      .map((t) => escapeRegExp(t).replace(/\\s+/g, "\\s+"))
      .join("|");
    collect(new RegExp(loose ? `(${body})` : `\\b(${body})\\b`, "gi"));
  }

  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: typeof hits = [];
  for (const h of hits) {
    const prev = merged[merged.length - 1];
    if (prev && h.start < prev.end) continue; // overlap: keep longer/earlier
    merged.push(h);
  }

  let last = 0;
  for (const h of merged) {
    if (h.start > last) {
      parts.push({ text: text.slice(last, h.start), hit: false, tip: null });
    }
    parts.push({
      text: text.slice(h.start, h.end),
      hit: true,
      tip: h.tip,
    });
    last = h.end;
  }
  if (last < text.length) {
    parts.push({ text: text.slice(last), hit: false, tip: null });
  }
  return parts.length ? parts : [{ text, hit: false, tip: null }];
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
          <mark
            key={i}
            className={`kw-hit${p.tip ? " kw-hit--tip" : ""}`}
            title={p.tip ?? undefined}
            data-tip={p.tip ?? undefined}
          >
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </span>
  );
}
