import type { AgentCardState } from "@/lib/agents/types";

const AGENT_ICONS: Record<string, string> = {
  scout: "🔭",
  technician: "📈",
  fundamentalist: "⚖️",
  newsdesk: "📰",
  bull: "🐂",
  bear: "🐻",
  judge: "⚖️",
  messenger: "📡",
};

type Props = {
  agents: AgentCardState[];
  className?: string;
};

export function AgentCardsGrid({ agents, className }: Props) {
  return (
    <div className={className ? `ag-grid ${className}` : "ag-grid"}>
      {agents.map((agent) => (
        <article
          key={agent.id}
          className={`ag-card ag-status-${agent.status}`}
        >
          <div className="ag-card-top">
            <span className="ag-icon" aria-hidden>
              {AGENT_ICONS[agent.id] ?? "🤖"}
            </span>
            <div>
              <h3 className="ag-card-name">{agent.name}</h3>
              <p className="ag-card-role">{agent.role}</p>
            </div>
            <span
              className={`ag-dot ag-dot-${agent.status}`}
              title={agent.status}
            />
          </div>
          <div className="ag-card-stats">
            <div>
              <span>{agent.stat1Label}</span>
              <strong>{agent.stat1}</strong>
            </div>
            <div>
              <span>{agent.stat2Label}</span>
              <strong>{agent.stat2}</strong>
            </div>
          </div>
          {agent.status === "working" ? (
            <div className="ag-bars" aria-hidden>
              <span />
              <span />
              <span />
            </div>
          ) : null}
        </article>
      ))}
    </div>
  );
}
