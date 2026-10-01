"use client";

import type { NapkinQwenHit } from "@/lib/napkin/client";
import { napkinAnalysis } from "@/lib/napkin/engine";
import { formatNapkinPct, parseDisplayedPct } from "@/lib/napkin/format";
import { parseQwenBaseCagr, qwenSection } from "@/lib/napkin/qwen-sections";
import type { NapkinResearch } from "@/lib/napkin/types";

export function napkinHurdlesFromUi(data: NapkinResearch, qwen: NapkinQwenHit | null) {
  const n = data.napkin;
  const base = qwen ? qwenSection(qwen.sections, ["BASE CASE"]) : null;
  const expected = parseQwenBaseCagr(base?.body);
  const pe = Number(n.current_pe);
  return napkinAnalysis({
    current_pe: Number.isFinite(pe) ? pe : null,
    historical_eps_cagr_3y: parseDisplayedPct(n.eps_cagr_3y),
    historical_eps_cagr_5y: parseDisplayedPct(n.eps_cagr_5y),
    expected_eps_cagr: expected,
  });
}

export function NapkinAssessment({
  data,
  qwen,
}: {
  data: NapkinResearch;
  qwen: NapkinQwenHit | null;
}) {
  const assess = qwen ? qwenSection(qwen.sections, ["NAPKIN ASSESSMENT"]) : null;
  const math = napkinHurdlesFromUi(data, qwen);
  const boxes = [
    { label: "Required EPS CAGR", value: formatNapkinPct(math.adjusted_required_cagr) },
    { label: "Base EPS CAGR", value: formatNapkinPct(math.expected_eps_cagr) },
    {
      label: "Growth Gap",
      value: formatNapkinPct(math.growth_gap_expected_adjusted, true),
    },
  ];
  return (
    <div className="napkin-valuation">
      <div className="napkin-boxes napkin-boxes-3">
        {boxes.map((b) => (
          <div key={b.label} className="napkin-box">
            <div className="napkin-box-label">{b.label}</div>
            <div className="napkin-box-value">{b.value}</div>
          </div>
        ))}
      </div>
      {qwen?.error ? <p className="napkin-error">{qwen.error}</p> : null}
      {assess ? (
        <div className="napkin-evidence">{assess.body}</div>
      ) : (
        <p className="napkin-pending">
          {qwen ? "Not available" : "Waiting for local Qwen."}
        </p>
      )}
    </div>
  );
}
