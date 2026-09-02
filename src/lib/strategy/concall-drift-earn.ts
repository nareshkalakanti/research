/** Which NSE announcement subjects count as post-results earn events. */

const JUNK_SUBJECTS = new Set([
  "Updates",
  "General Updates",
  "Appointment",
  "Dividend",
  "Preferential issue",
  "Disclosure of material issue",
  "Change in Management",
  "Acquisition",
  "Amalgamation/Merger",
  "Resignation",
  "Related Party Transactions",
  "Corporate Insolvency Resolution Process",
  "Corrigendum",
]);

function blob(desc: string, attachmentText: string, file = ""): string {
  return `${desc} ${attachmentText} ${file}`.toLowerCase();
}

/** Classify NSE announcement body text (desc + attachment). */
export function isFinancialEarnAnnouncement(
  desc: string,
  attachmentText: string,
  file = "",
): boolean {
  const b = blob(desc, attachmentText, file);

  if (
    /preferential|postal ballot|buyback|delisting|insolvency|change in management|related party|amalgamation\/merger|appointment|resignation|acquisition|material issue/i.test(
      b,
    ) &&
    !/financial\s+result|unaudited|audited|quarterly\s+result|annual\s+result|integrated filing- financial/i.test(
      b,
    )
  ) {
    return false;
  }

  if (
    /financial\s+result|unaudited\s+financial|audited\s+financial|quarterly\s+result|annual\s+result|integrated filing- financial|reasons for delayed\/non-submission of financial|clarification.*financial|reply to clarification.*financial/i.test(
      b,
    )
  ) {
    return true;
  }

  if (/newspaper publication/i.test(b)) {
    return /financial\s+result|unaudited|audited|quarterly|annual/i.test(b);
  }

  if (/outcome\s+of\s+board/i.test(b)) {
    return /financial|unaudited|audited|quarterly|annual\s+result|integrated filing|revenue|profit|ebitda|\beps\b|\bpat\b|interim dividend|dividend.*interim/i.test(
      b,
    );
  }

  if (/press release/i.test(b)) {
    return /financial|result|unaudited|audited|quarter|revenue|profit|earnings|ebitda/i.test(
      b,
    );
  }

  return false;
}

/** Stored subject-only filter for rows already in SQLite. */
export function isFinancialEarnSubject(subject: string | null): boolean {
  if (!subject) return false;
  const s = subject.trim();
  if (JUNK_SUBJECTS.has(s)) return false;
  if (/^copy of newspaper publication$/i.test(s)) return false;
  if (
    /^integrated filing- financial$/i.test(s) ||
    /financial result|clarification.*financial|reply to clarification.*financial|reasons for delayed\/non-submission of financial/i.test(
      s,
    )
  ) {
    return true;
  }
  if (/^outcome of board meeting$/i.test(s) || /^press release/i.test(s)) {
    return false;
  }
  return false;
}

/** Outcome-of-board / press-release rows need a revalidated baseline to display. */
export function needsValidatedBaseline(subject: string | null): boolean {
  if (!subject) return true;
  const s = subject.trim();
  return (
    /^outcome of board meeting$/i.test(s) ||
    /^press release/i.test(s) ||
    /^copy of newspaper publication$/i.test(s)
  );
}

export function passesEarnQuality(
  subject: string | null,
  hasValidatedBaseline: boolean,
): boolean {
  if (!isFinancialEarnSubject(subject)) {
    if (!needsValidatedBaseline(subject)) return false;
    return hasValidatedBaseline;
  }
  if (needsValidatedBaseline(subject) && !hasValidatedBaseline) return false;
  return true;
}

export const CONCALL_DRIFT_JUNK_SUBJECTS = [...JUNK_SUBJECTS];
