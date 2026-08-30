import {
  listRecentSeatEvents,
  seatEventSummary,
  type BoardSeatEvent,
} from "./governance-changes";

export type GovBriefSignal = "Stable" | "Churn" | "Red flag";

const EXEC_RE =
  /\b(managing director|whole[- ]?time director|executive director|ceo|cfo|chief financial|chief executive)\b/i;

function isExecutiveEvent(e: BoardSeatEvent): boolean {
  const text = [e.old_designation, e.new_designation, e.old_category, e.new_category]
    .filter(Boolean)
    .join(" ");
  return EXEC_RE.test(text);
}

function withinMonths(iso: string, months: number): boolean {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return false;
  return Date.now() - t <= months * 30 * 86400000;
}

/** Board churn summary from governance.db seat events (last 12 months). */
export function buildGovernanceBrief(ticker: string): {
  signal: GovBriefSignal | null;
  reason: string;
} {
  const events = listRecentSeatEvents({ ticker, limit: 80 }).filter((e) =>
    withinMonths(e.detected_at, 12),
  );

  if (!events.length) {
    return {
      signal: "Stable",
      reason: "No director changes recorded in the last 12 months.",
    };
  }

  const summary = seatEventSummary(events);
  const execEvents = events.filter(isExecutiveEvent);
  const execResign = execEvents.filter((e) => e.event_type === "resigned").length;
  const execRole = execEvents.filter((e) => e.event_type === "role_changed").length;

  let signal: GovBriefSignal = "Stable";
  if (summary.resigned >= 2 || execResign >= 1) {
    signal = "Red flag";
  } else if (
    summary.resigned >= 1 ||
    summary.role_changed >= 2 ||
    execRole >= 1 ||
    summary.joined + summary.resigned + summary.role_changed >= 3
  ) {
    signal = "Churn";
  }

  const bits: string[] = [];
  if (summary.joined) bits.push(`${summary.joined} joined`);
  if (summary.resigned) bits.push(`${summary.resigned} left`);
  if (summary.role_changed) bits.push(`${summary.role_changed} role changes`);
  const reason =
    bits.length > 0
      ? `${bits.join(", ")} in last 12 months.`
      : "Board activity in last 12 months.";

  if (execResign > 0) {
    return {
      signal,
      reason: `${reason} Executive director exit — verify continuity.`,
    };
  }
  if (execRole > 0 && signal !== "Red flag") {
    return {
      signal,
      reason: `${reason} Executive role change noted.`,
    };
  }

  return { signal, reason };
}
