/** Empty / prompt-echo text that must not appear as research facts. */

const EMPTY_WATCH =
  /^(?:no\s+(?:specific\s+)?risks?\b|(?:none|n\/?a|nil|not\s+disclosed|not\s+mentioned|not\s+stated)\.?$)/i;

const RISK_NEGATION =
  /\b(?:no|none|not)\s+(?:specific\s+)?risks?\s+(?:mentioned|stated|disclosed|identified|flagged|noted)\b/i;

const IDENTITY_LABEL =
  /^(?:company\s+name|name|ticker|symbol)\s*(?:\([^)]*\))?\s*:/i;

export function isPlaceholderWatch(text: string | null | undefined): boolean {
  const t = (text || "").replace(/\s+/g, " ").trim();
  if (!t) return true;
  if (EMPTY_WATCH.test(t)) return true;
  if (RISK_NEGATION.test(t)) return true;
  if (IDENTITY_LABEL.test(t)) return true;
  if (/^company\s+name\b/i.test(t) && t.length < 80) return true;
  return false;
}

export function dropPlaceholderLines(text: string | null | undefined): string {
  return (text || "")
    .split(/\n+/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l && !isPlaceholderWatch(l) && !IDENTITY_LABEL.test(l))
    .join("\n")
    .trim();
}

export function usableWatchText(text: string | null | undefined): string {
  const t = dropPlaceholderLines(text);
  if (!t || isPlaceholderWatch(t)) return "";
  if (/risks related to global market|crowded sector/i.test(t)) return "";
  return t.slice(0, 240);
}
