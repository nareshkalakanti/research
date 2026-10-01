import { napkinMetric } from "@/lib/napkin/format";
import type { NapkinResearch } from "@/lib/napkin/types";

export function NapkinEarnings({ data }: { data: NapkinResearch }) {
  const f = data.financials;
  const rows = [
    { label: "Revenue CAGR", y3: napkinMetric(f, "rev3"), y5: napkinMetric(f, "rev5") },
    { label: "EPS CAGR", y3: napkinMetric(f, "eps3"), y5: napkinMetric(f, "eps5") },
    { label: "Profit CAGR", y3: napkinMetric(f, "p3"), y5: napkinMetric(f, "p5") },
    { label: "Margin", y3: napkinMetric(f, "m3"), y5: napkinMetric(f, "m5") },
  ];
  return (
    <div className="napkin-table-wrap">
      <table className="napkin-table">
        <thead>
          <tr>
            <th>Metric</th>
            <th>3Y</th>
            <th>5Y</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label}>
              <td>{r.label}</td>
              <td>{r.y3}</td>
              <td>{r.y5}</td>
            </tr>
          ))}
          <tr>
            <td>ROE</td>
            <td>—</td>
            <td>{napkinMetric(data.overview, "roe")}</td>
          </tr>
          <tr>
            <td>ROCE</td>
            <td>—</td>
            <td>{napkinMetric(data.overview, "roce")}</td>
          </tr>
        </tbody>
      </table>
      {data.data_quality?.reason ? (
        <p className="napkin-pending">{data.data_quality.reason}</p>
      ) : null}
    </div>
  );
}
