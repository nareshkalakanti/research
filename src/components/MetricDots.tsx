"use client";

import { fmtYoYPct } from "@/lib/quarter-panel";
import { formatPeDisplay, forwardPeClass } from "@/lib/valuation";

type Props = {
  forwardPe?: number | null;
  epsYoY?: number | null;
  salesYoY?: number | null;
  /** Not in quarter_metrics cache — show hollow dots until Fill dots / expand. */
  pending?: boolean;
};

function fpeDotClass(pe: number | null | undefined): string {
  const c = forwardPeClass(pe ?? null);
  if (c === "fpe-good") return "metric-dot--good";
  if (c === "fpe-mid") return "metric-dot--mid";
  if (c === "fpe-bad") return "metric-dot--bad";
  return "metric-dot--na";
}

function yoyDotClass(yoy: number | null | undefined): string {
  if (yoy == null || !Number.isFinite(yoy)) return "metric-dot--na";
  if (yoy > 0) return "metric-dot--good";
  if (yoy < 0) return "metric-dot--bad";
  return "metric-dot--mid";
}

function dotClass(
  value: number | null | undefined,
  kind: "pe" | "yoy",
  pending: boolean,
): string {
  if (pending) return "metric-dot--pending";
  return kind === "pe" ? fpeDotClass(value) : yoyDotClass(value);
}

function peTitle(pe: number | null | undefined, pending: boolean): string {
  if (pending) return "Fwd PE — not scanned yet";
  if (pe == null || !Number.isFinite(pe)) return "Fwd PE — no data";
  return `Fwd PE ${formatPeDisplay(pe)} — lower is cheaper (≤20 green)`;
}

function yoyTitle(
  label: string,
  yoy: number | null | undefined,
  pending: boolean,
): string {
  if (pending) return `${label} — not scanned yet`;
  if (yoy == null || !Number.isFinite(yoy)) return `${label} — no data`;
  return `${label} ${fmtYoYPct(yoy)} — vs same quarter last year`;
}

/** Three traffic-light dots: Fwd PE · EPS YoY · Sales YoY (always visible). */
export function MetricDots({
  forwardPe,
  epsYoY,
  salesYoY,
  pending = false,
}: Props) {
  return (
    <span
      className={`metric-dots${pending ? " metric-dots--pending" : ""}`}
      aria-label={pending ? "Quarter metrics not scanned" : "Quarter metrics"}
      title={pending ? "Not scanned — expand row or use Fill dots" : undefined}
    >
      <span
        className={`metric-dot ${dotClass(forwardPe, "pe", pending)}`}
        title={peTitle(forwardPe ?? null, pending)}
      />
      <span
        className={`metric-dot ${dotClass(epsYoY, "yoy", pending)}`}
        title={yoyTitle("EPS YoY", epsYoY ?? null, pending)}
      />
      <span
        className={`metric-dot ${dotClass(salesYoY, "yoy", pending)}`}
        title={yoyTitle("Sales YoY", salesYoY ?? null, pending)}
      />
    </span>
  );
}
