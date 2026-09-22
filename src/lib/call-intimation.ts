/**
 * Exchange cover letters / audio-recording intimations are not PPT decks
 * and must not fill the PPT slot or invent a P&L.
 */

/** Reg. 33 board-outcome / results PDF (P&L tables) — not a call intimation. */
export function isFinancialResultsBlob(text: string): boolean {
  const t = (text || "").replace(/\s+/g, " ").trim();
  if (!t) return false;
  if (
    /STATEMENT OF .{0,80}FINANCIAL RESULTS/i.test(t) &&
    /Revenue from Operations/i.test(t)
  ) {
    return true;
  }
  if (
    /EXTRACT OF .{0,80}FINANCIAL RESULTS/i.test(t) &&
    /(?:Revenue from Operations|Total Income|Profit (?:after|for the) tax|\bPAT\b)/i.test(
      t,
    )
  ) {
    return true;
  }
  if (
    /Outcome of Board Meeting/i.test(t) &&
    /Regulation\s*33/i.test(t) &&
    /(?:Audited|Unaudited)\s+Financial Results/i.test(t)
  ) {
    return true;
  }
  return false;
}

export function isFinancialResultsHit(opts: {
  title?: string | null;
  url?: string | null;
  kind?: string | null;
}): boolean {
  if (isCallIntimationHit(opts)) return false;
  const blob = `${opts.kind || ""} ${opts.title || ""} ${opts.url || ""}`;
  if (
    /investor\s+meet|analyst\s+meet|conference\s+call\s+outcome|outcome of meeting of analysts|institutional\s+investors?\s+reg/i.test(
      blob,
    )
  ) {
    return false;
  }
  if (/financial\s+result|audited\s+financial|unaudited\s+financial/i.test(blob)) {
    return true;
  }
  if (
    /newspaper/i.test(blob) &&
    /(?:unaudited|audited|financial\s+result|extract)/i.test(blob)
  ) {
    return true;
  }
  // Bare “Outcome of Board Meeting” is often a meet letter, not Reg. 33 P&L.
  if (
    /outcome\s+of\s+(?:the\s+)?board|_Outcome\.pdf/i.test(blob) &&
    /(?:regulation\s*33|audited|unaudited|financial\s+result)/i.test(blob)
  ) {
    return true;
  }
  return false;
}

/** Cover letter + enclosed earnings deck in the same PDF. */
export function looksLikeEnclosedEarningsDeck(text: string): boolean {
  const t = (text || "").replace(/\s+/g, " ").trim();
  if (!t) return false;
  const hasDeckTitle =
    /Investor Presentation|Earnings Presentation|Financial Snapshot/i.test(t);
  const hasPnl =
    /Operating EBITDA|Reported EBITDA|Total Income/i.test(t) &&
    /(?:INR|Rs\.?|₹)\s*(Mn|Million|Cr|Crore|Lacs?|Lakhs?)/i.test(t);
  const hasSlideCue =
    /Q[1-4]\s*FY\s*\d{2}|Disclaimer|Safe Harbour/i.test(t);
  return hasDeckTitle && (hasPnl || (hasSlideCue && t.length >= 4_000));
}

export function isCallIntimationBlob(text: string): boolean {
  const t = (text || "").replace(/\s+/g, " ").trim();
  if (!t) return false;
  if (isFinancialResultsBlob(t)) return false;
  if (looksLikeEnclosedEarningsDeck(t)) return false;
  if (
    /Moderator\s*:|Ladies and gentlemen|Good (?:morning|afternoon|evening).{0,80}welcome to the/i.test(
      t,
    )
  ) {
    return false;
  }
  if (
    /Investor Presentation|Earnings Presentation|Safe Harbour Statement/i.test(
      t,
    ) &&
    /(?:revenue|ebitda|net sales)/i.test(t)
  ) {
    return false;
  }
  const head = t.slice(0, 6_000);
  if (/audio\s+recording/i.test(head)) return true;
  if (/covering[_\s-]?letter/i.test(head)) return true;
  if (
    /pursuant to regulation\s*30/i.test(head) &&
    /(?:earnings|conference)\s+call/i.test(head) &&
    t.length < 8_000 &&
    !/\bQ[1-4]\b.{0,40}(?:revenue|sales|ebitda)/i.test(head)
  ) {
    return true;
  }
  if (
    t.length < 8_000 &&
    /please find (?:the\s+)?(?:attached|enclosed)|has been uploaded on (?:the\s+)?(?:company['’]?s\s+)?website|can (?:also )?be accessed through the following link/i.test(
      head,
    ) &&
    /(?:investor|earnings)\s+presentation|(?:earnings|conference)\s+call|transcript/i.test(
      head,
    ) &&
    !/STATEMENT OF .{0,40}FINANCIAL RESULTS|Revenue from Operations/i.test(t)
  ) {
    return true;
  }
  // Reg. 30 analyst / institutional-investor meet letters (schedule or outcome).
  if (
    t.length < 8_000 &&
    /regulation\s*30/i.test(head) &&
    /(?:analyst|institutional\s+investor)/i.test(head) &&
    /(?:meet|meeting)/i.test(head) &&
    !/STATEMENT OF .{0,40}FINANCIAL RESULTS|Revenue from Operations|EXTRACT OF .{0,40}FINANCIAL RESULTS/i.test(
      t,
    )
  ) {
    return true;
  }
  return false;
}

/** http(s) PDF links printed in a covering letter (newlines inside the URL collapsed). */
export function embeddedFilingPdfUrls(text: string): string[] {
  const raw = text || "";
  const found: string[] = [];
  const re =
    /https?:\/\/[^\s<>"'\)\]]+(?:\s+[^\s<>"'\)\]]+)*?\.pdf\b/gi;
  for (const m of raw.matchAll(re)) {
    const u = m[0].replace(/\s+/g, "");
    if (/^https?:\/\//i.test(u) && !/\.mp3($|\?)/i.test(u)) found.push(u);
  }
  return [...new Set(found)];
}

export function followPdfUrlFromIntimation(
  text: string,
  role: "transcript" | "ppt",
): string | null {
  const urls = embeddedFilingPdfUrls(text);
  if (!urls.length) return null;
  const score = (u: string) => {
    const b = u.toLowerCase();
    if (role === "transcript") {
      if (/transcript|earnings.?call|concall/i.test(b)) return 3;
      if (/presentation|investor.?ppt|_ip_/i.test(b)) return 0;
      return 1;
    }
    if (/presentation|investor.?ppt|_ip_|earnings.?deck/i.test(b)) return 3;
    if (/transcript/i.test(b)) return 0;
    return 1;
  };
  const ranked = [...urls].sort((a, b) => score(b) - score(a));
  const best = ranked[0];
  if (!best || score(best) <= 0) return null;
  return best;
}

export function isCallIntimationHit(opts: {
  title?: string | null;
  url?: string | null;
  kind?: string | null;
}): boolean {
  const blob = `${opts.kind || ""} ${opts.title || ""} ${opts.url || ""}`;
  if (
    /newspaper/i.test(blob) &&
    /(?:unaudited|audited|financial\s+result)/i.test(blob)
  ) {
    return false;
  }
  return /covering[_\s-]?letter|audio[_\s-]?record|intimation of.{0,80}(?:analyst|investor).{0,40}meet|outcome of meeting of analysts|invconcall|seltr.?outcome|outcomeinvconcall|institutional\s+investors?.{0,40}(?:concall|meet)/i.test(
    blob,
  );
}
