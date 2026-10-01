import type { NapkinMetric } from "@/lib/napkin/types";

export function NapkinMetricGrid({ items }: { items: NapkinMetric[] }) {
  return (
    <div className="napkin-metrics">
      {items.map((m) => (
        <article key={m.key} className="napkin-metric">
          <div className="napkin-metric-label">{m.label}</div>
          <div className="napkin-metric-value">{m.value}</div>
        </article>
      ))}
    </div>
  );
}
