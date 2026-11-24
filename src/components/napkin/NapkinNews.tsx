"use client";

import { useEffect, useState } from "react";

type Item = { title: string; url: string | null; date: string | null; summary: string | null; source: string | null };
type Res = {
  status: "ok" | "empty" | "mismatch" | "limited" | "unavailable";
  items: Item[];
  matched_name: string | null;
};

function when(iso: string | null): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const days = Math.floor((Date.now() - t) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 30) return `${days} days ago`;
  return new Date(t).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

/** Recent news for the open stock (IndianAPI), fetched only when Napkin shows it. */
export function NapkinNews({ ticker, name }: { ticker: string; name: string }) {
  const [res, setRes] = useState<{ t: string; r: Res | null; err: boolean } | null>(null);

  useEffect(() => {
    let live = true;
    void fetch(`/api/napkin/news?ticker=${encodeURIComponent(ticker)}&name=${encodeURIComponent(name)}`, {
      cache: "no-store",
    })
      .then((r) => r.json())
      .then((j: Res & { ok?: boolean }) => {
        if (live) setRes({ t: ticker, r: j.ok === false ? null : j, err: j.ok === false });
      })
      .catch(() => {
        if (live) setRes({ t: ticker, r: null, err: true });
      });
    return () => {
      live = false;
    };
  }, [ticker, name]);

  const cur = res?.t === ticker ? res : null;
  const r = cur?.r ?? null;

  return (
    <div className="napkin-sheet-section napkin-news">
      <h2 className="napkin-block-title">News</h2>
      {!cur ? (
        <p className="napkin-news-msg">Loading news…</p>
      ) : cur.err || !r || r.status === "unavailable" ? (
        <p className="napkin-news-msg">News is unavailable right now.</p>
      ) : r.status === "limited" ? (
        <p className="napkin-news-msg">IndianAPI request limit reached. News will load again later.</p>
      ) : r.status === "mismatch" ? (
        <p className="napkin-news-msg">
          No news shown: IndianAPI matched {r.matched_name ? `“${r.matched_name}”` : "a different company"}, not {name}.
        </p>
      ) : !r.items.length ? (
        <p className="napkin-news-msg">No recent news for {name}.</p>
      ) : (
        <ul className="napkin-news-list">
          {r.items.map((n) => (
            <li key={`${n.title}-${n.date ?? ""}`}>
              {n.url ? (
                <a href={n.url} target="_blank" rel="noopener noreferrer" className="napkin-news-title">
                  {n.title}
                </a>
              ) : (
                <span className="napkin-news-title">{n.title}</span>
              )}
              <span className="napkin-news-meta">
                {[when(n.date), n.source].filter(Boolean).join(" · ")}
              </span>
              {n.summary ? <p className="napkin-news-sum">{n.summary}</p> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
