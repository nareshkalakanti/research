import type { NapkinResearch } from "@/lib/napkin/types";
import { napkinPeDisplay } from "@/lib/napkin/format";

export function NapkinAnalysis({ data }: { data: NapkinResearch }) {
  const n = data.napkin;
  const pe = napkinPeDisplay(n.current_pe);
  const boxes = [
    { label: "Current P/E", value: pe },
    { label: "Basic required CAGR", value: n.basic_required_cagr },
    { label: "Adjusted required CAGR", value: n.adjusted_required_cagr },
    { label: "EPS CAGR 3Y", value: n.eps_cagr_3y },
    { label: "EPS CAGR 5Y", value: n.eps_cagr_5y },
    { label: "Base growth gap", value: n.growth_gap_hist_adjusted_5y },
  ];
  return (
    <div className="napkin-valuation">
      <div className="napkin-boxes">
        {boxes.map((b) => (
          <div key={b.label} className="napkin-box">
            <div className="napkin-box-label">{b.label}</div>
            <div className="napkin-box-value">{b.value}</div>
          </div>
        ))}
      </div>
      <div className="napkin-formula">
        <div>
          Basic: ({n.current_pe === "N/A" ? "PE" : n.current_pe} × 0.30)^(1/5) − 1 ={" "}
          {n.basic_required_cagr}
        </div>
        <div>
          Adjusted: ({n.current_pe === "N/A" ? "PE" : n.current_pe} × factor)^(1/5) − 1 ={" "}
          {n.adjusted_required_cagr}
        </div>
        <div className="napkin-formula-note">
          factor is configurable (default 4.5/34.5 reproduction knob), not a universal rule.
        </div>
      </div>
    </div>
  );
}
