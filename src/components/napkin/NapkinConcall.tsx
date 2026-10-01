"use client";

import type { NapkinConcallTrack } from "@/lib/napkin/concall-track";

const THEME_LABEL: Record<string, string> = {
  repeated_promises: "Repeated promises",
  achieved_guidance: "Achieved guidance",
  missed_guidance: "Missed guidance",
  delayed_projects: "Delayed projects",
  changing_explanations: "Changing explanations",
  new_growth_drivers: "New growth drivers",
  discontinued_growth_drivers: "Discontinued growth drivers",
  margin_expectation_changes: "Margin expectation changes",
  capex_plan_changes: "Capex plan changes",
  orderbook_commentary_changes: "Order-book commentary changes",
};

export function NapkinConcall({ track }: { track: NapkinConcallTrack | null }) {
  if (!track) {
    return <p className="napkin-pending">Concall track record has not run yet.</p>;
  }
  if (track.error && !track.rows.length) {
    return <p className="napkin-pending">{track.error}</p>;
  }
  const themeEntries = Object.entries(track.themes).filter(([, v]) => v.length);
  return (
    <div className="napkin-concall">
      {track.error ? <p className="napkin-error">{track.error}</p> : null}
      {track.rows.length ? (
        <div className="napkin-table-wrap">
          <table className="napkin-table">
            <thead>
              <tr>
                <th>Quarter</th>
                <th>Management claim</th>
                <th>Expected timeframe</th>
                <th>Subsequent result</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {track.rows.map((r, i) => (
                <tr key={`${r.quarter}-${i}`}>
                  <td>{r.quarter}</td>
                  <td>
                    {r.claim}
                    {r.source && r.source !== "Not available" ? (
                      <div className="napkin-progress-detail">{r.source}</div>
                    ) : null}
                  </td>
                  <td>{r.timeframe}</td>
                  <td>{r.subsequent_result}</td>
                  <td>{r.status.replace(/_/g, " ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="napkin-pending">No claim/result pairs in the packet.</p>
      )}
      {track.repeated_across_quarters.length ? (
        <div>
          <h3>Repeated across quarters</h3>
          <ul className="napkin-notes">
            {track.repeated_across_quarters.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {themeEntries.map(([k, items]) => (
        <div key={k}>
          <h3>{THEME_LABEL[k] || k}</h3>
          <ul className="napkin-notes">
            {items.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
