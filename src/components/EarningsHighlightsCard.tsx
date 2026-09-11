"use client";

/**
 * Reusable earnings highlights UI (test/hightlight.html layout).
 * Data-driven from analyze JSON — no company hardcoding.
 */

export type HighlightItem = {
  text: string;
  polarity?: string | null;
  sentiment?: string | null;
};

function normalizePolarity(
  raw: string | null | undefined,
  text: string,
): "positive" | "negative" | "neutral" {
  const p = String(raw || "").toLowerCase();
  if (p === "positive" || p === "negative" || p === "neutral") return p;
  if (
    /miss|cut|reset|delay|decline|loss|weak|compress|headwind|cautious|hit/i.test(
      text,
    )
  ) {
    return "negative";
  }
  if (
    /grew|growth|won|win|record|beat|raise|strong|capacity|order inflow|ramp/i.test(
      text,
    )
  ) {
    return "positive";
  }
  return "neutral";
}

/** Map HL / card score onto 0–10 for Congrats Index display. */
export function scoreOutOfTen(score: number | null | undefined): number | null {
  if (score == null || !Number.isFinite(score)) return null;
  if (score >= 0 && score <= 1) return Math.round(score * 100) / 10;
  if (score > 1 && score <= 10) return Math.round(score * 10) / 10;
  return Math.round(score * 10) / 10;
}

function toneClass(
  label: string | null | undefined,
  kind: "quality" | "sentiment",
): "positive" | "negative" | "neutral" {
  const t = String(label || "").toLowerCase();
  if (kind === "quality") {
    if (/excellent|strong/.test(t)) return "positive";
    if (/weak/.test(t)) return "negative";
    return "neutral";
  }
  if (/optimistic|bullish|positive/.test(t)) return "positive";
  if (/cautious|bearish|negative/.test(t)) return "negative";
  return "neutral";
}

/** Bullet list for Highlights column / card. */
export function HighlightsBulletList({
  items,
  max = 5,
}: {
  items: HighlightItem[] | null | undefined;
  max?: number;
}) {
  if (!items?.length) return <span className="ehc-empty">—</span>;
  const shown = items.slice(0, max);
  return (
    <ul
      className="ehc-hl-list"
      title={items.map((h) => h.text).join(" · ")}
    >
      {shown.map((h, i) => {
        const pol = normalizePolarity(
          h.polarity || h.sentiment,
          h.text,
        );
        return (
          <li key={`${h.text}-${i}`} className="ehc-hl-item">
            <span className={`ehc-hl-bullet ehc-hl-bullet--${pol}`} />
            <span className="ehc-hl-text">{h.text}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** Result Quality / Tone selector-style box. */
export function MetricSelectorBox({
  label,
  value,
  kind,
  showLabel = true,
}: {
  label: string;
  value: string | null | undefined;
  kind: "quality" | "sentiment";
  /** When false (PASS table), column header already names the field. */
  showLabel?: boolean;
}) {
  if (!value) return <span className="ehc-empty">—</span>;
  const tone = toneClass(value, kind);
  const display =
    kind === "sentiment"
      ? value.charAt(0).toUpperCase() + value.slice(1).toLowerCase()
      : value;
  const arrow =
    tone === "positive" ? "↑" : tone === "negative" ? "↓" : "→";
  return (
    <div
      className={`ehc-selector${showLabel ? "" : " ehc-selector--compact"}`}
      title={label}
    >
      {showLabel ? <div className="ehc-selector-label">{label}</div> : null}
      <div className={`ehc-selector-value ehc-selector-value--${tone}`}>
        <span>{display}</span>
        <span className="ehc-chevron" aria-hidden>
          {arrow}
        </span>
      </div>
    </div>
  );
}

/** Congrats Index / score box. */
export function CongratsScoreBox({
  score,
}: {
  score: number | null | undefined;
}) {
  const n = scoreOutOfTen(score);
  if (n == null) {
    return (
      <div className="ehc-metric ehc-metric--locked" title="Score pending Analyze">
        <span className="ehc-lock" aria-hidden>
          🔒
        </span>
      </div>
    );
  }
  const up = n >= 5;
  return (
    <div className="ehc-metric" title="Overall highlight score">
      <div className="ehc-metric-label">Score</div>
      <div className="ehc-metric-value">
        <span className="ehc-metric-text">{n.toFixed(1)}</span>
        <span
          className={up ? "ehc-arrow ehc-arrow--up" : "ehc-arrow ehc-arrow--down"}
          aria-hidden
        >
          {up ? "↑" : "↓"}
        </span>
      </div>
      <div className="ehc-metric-den">/ 10</div>
    </div>
  );
}

/** Full 4-column card (Highlights | Score | Result | Sentiment). */
export function EarningsHighlightsCard({
  highlights,
  resultQuality,
  mgmtSentiment,
  score,
}: {
  highlights?: HighlightItem[] | null;
  resultQuality?: string | null;
  mgmtSentiment?: string | null;
  score?: number | null;
}) {
  return (
    <div className="ehc-card">
      <div className="ehc-card-head">
        <div className="ehc-head-label">Highlights</div>
        <div className="ehc-head-label ehc-head-info">
          Congrats Index
          <span className="ehc-info" title="Overall score from highlight sentiment JSON">
            i
          </span>
        </div>
        <div className="ehc-head-label">Result Quality</div>
        <div className="ehc-head-label">Mgmt Sentiment</div>
      </div>
      <div className="ehc-card-body">
        <div className="ehc-col-hl">
          <HighlightsBulletList items={highlights} />
        </div>
        <CongratsScoreBox score={score} />
        <MetricSelectorBox
          label="Rating"
          value={resultQuality}
          kind="quality"
        />
        <MetricSelectorBox
          label="Tone"
          value={mgmtSentiment}
          kind="sentiment"
        />
      </div>
    </div>
  );
}
