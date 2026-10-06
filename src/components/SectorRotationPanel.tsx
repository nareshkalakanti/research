"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ROTATION_RANGES } from "@/lib/sector-rotation-series";

type Point = { date: string; value: number };

type Card = {
  id: string;
  label: string;
  n: number;
  sector_pct: number | null;
  bench_pct: number | null;
  sector: Point[];
  bench: Point[];
};

type Member = {
  ticker: string;
  name: string;
  market: string;
  mcap_cr: number | null;
  price: number | null;
  change_pct: number | null;
  window_pct: number | null;
  spark: Point[];
  tv_url: string;
};

type Hit = { ticker: string; name: string; market?: string; source?: string };

function fmtPct(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

function fmtCr(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 0 })} Cr`;
}

function DualSpark({
  a,
  b,
  width = 320,
  height = 120,
  showEnd = true,
  aLabel = "Sector",
  bLabel = "Nifty",
}: {
  a: Point[];
  b: Point[];
  width?: number;
  height?: number;
  showEnd?: boolean;
  aLabel?: string;
  bLabel?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const dates = [...new Set([...a, ...b].map((p) => p.date))].sort();
  const mapA = new Map(a.map((p) => [p.date, p.value]));
  const mapB = new Map(b.map((p) => [p.date, p.value]));
  const ys = [...a, ...b].map((p) => p.value);
  const lo = Math.min(100, ...ys, 80);
  const hi = Math.max(100, ...ys, 120);
  const pad = (hi - lo) * 0.1 || 2;
  const y0 = lo - pad;
  const y1 = hi + pad;
  const t0 = dates.length
    ? new Date(`${dates[0]}T00:00:00Z`).getTime()
    : 0;
  const t1 = dates.length
    ? new Date(`${dates[dates.length - 1]}T00:00:00Z`).getTime()
    : 1;
  const span = Math.max(1, t1 - t0);
  const left = 8;
  const right = showEnd ? 44 : 8;
  const xAt = (d: string) =>
    left + ((new Date(`${d}T00:00:00Z`).getTime() - t0) / span) * (width - left - right);
  const yAt = (v: number) =>
    height - 14 - ((v - y0) / (y1 - y0)) * (height - 22);
  const line = (pts: Point[]) =>
    pts.length < 2
      ? ""
      : pts
          .map(
            (p, i) =>
              `${i === 0 ? "M" : "L"}${xAt(p.date).toFixed(1)} ${yAt(p.value).toFixed(1)}`,
          )
          .join(" ");
  const lastA = a[a.length - 1];
  const lastB = b[b.length - 1];
  const hoverDate = hover != null ? dates[hover] : null;
  const ha = hoverDate ? mapA.get(hoverDate) : null;
  const hb = hoverDate ? mapB.get(hoverDate) : null;
  return (
    <div className="rot-spark-wrap">
      <svg
        className="rot-spark"
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const x = ((e.clientX - rect.left) / rect.width) * width;
          let best = 0;
          let bestD = 1e9;
          dates.forEach((d, i) => {
            const dx = Math.abs(xAt(d) - x);
            if (dx < bestD) {
              bestD = dx;
              best = i;
            }
          });
          setHover(best);
        }}
      >
        {line(b) ? (
          <path
            d={line(b)}
            fill="none"
            stroke="#94a3b8"
            strokeDasharray="3 3"
            strokeWidth="1.5"
          />
        ) : null}
        {line(a) ? (
          <path d={line(a)} fill="none" stroke="#22c55e" strokeWidth="2" />
        ) : null}
        {lastA && showEnd ? (
          <g>
            <rect
              x={width - 42}
              y={yAt(lastA.value) - 8}
              width="40"
              height="14"
              rx="3"
              fill="#22c55e"
            />
            <text
              x={width - 22}
              y={yAt(lastA.value) + 2}
              textAnchor="middle"
              fontSize="8"
              fill="#052e16"
            >
              {lastA.value.toFixed(1)}
            </text>
          </g>
        ) : null}
        {lastB && showEnd ? (
          <g>
            <rect
              x={width - 42}
              y={yAt(lastB.value) - 8}
              width="40"
              height="14"
              rx="3"
              fill="#64748b"
            />
            <text
              x={width - 22}
              y={yAt(lastB.value) + 2}
              textAnchor="middle"
              fontSize="8"
              fill="#fff"
            >
              {lastB.value.toFixed(1)}
            </text>
          </g>
        ) : null}
        {hoverDate ? (
          <line
            x1={xAt(hoverDate)}
            x2={xAt(hoverDate)}
            y1={8}
            y2={height - 12}
            stroke="#64748b"
            strokeDasharray="2 2"
          />
        ) : null}
      </svg>
      <div className="rot-legend">
        <span className="rot-leg-a">{aLabel}</span>
        <span className="rot-leg-b">{bLabel}</span>
        {hoverDate ? (
          <span className="rot-hover">
            {hoverDate}
            {ha != null ? ` · ${ha.toFixed(1)}` : ""}
            {hb != null ? ` / ${hb.toFixed(1)}` : ""}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function MiniSpark({ pts }: { pts: Point[] }) {
  if (pts.length < 2) return null;
  const up = (pts[pts.length - 1]?.value ?? 0) >= (pts[0]?.value ?? 0);
  const w = 72;
  const h = 22;
  const ys = pts.map((p) => p.value);
  const lo = Math.min(...ys);
  const hi = Math.max(...ys);
  const span = hi - lo || 1;
  const d = pts
    .map((p, i) => {
      const x = (i / (pts.length - 1)) * w;
      const y = h - ((p.value - lo) / span) * h;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg className="rot-mini" width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      <path d={d} fill="none" stroke={up ? "#22c55e" : "#ef4444"} strokeWidth="1.6" />
    </svg>
  );
}

export function SectorRotationPanel() {
  const [range, setRange] = useState("6M");
  const [cards, setCards] = useState<Card[]>([]);
  const [asOf, setAsOf] = useState<string | null>(null);
  const [benchLabel, setBenchLabel] = useState(
    "Nifty 500",
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{
    card: Card;
    members: Member[];
  } | null>(null);
  const [newName, setNewName] = useState("");
  const [addQ, setAddQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState("");
  const [memberQ, setMemberQ] = useState("");
  const [view, setView] = useState<"grid" | "table">("grid");
  const [editLabel, setEditLabel] = useState("");
  const [shotBusy, setShotBusy] = useState(false);
  const [shotQueued, setShotQueued] = useState(0);
  const [shotPreview, setShotPreview] = useState<string | null>(null);
  const [shotDrag, setShotDrag] = useState(false);
  const [shotLog, setShotLog] = useState<string[]>([]);
  const shotUrl = useRef<string | null>(null);
  const shotWell = useRef<HTMLDivElement>(null);
  const shotQueue = useRef<File[]>([]);
  const shotRunning = useRef(false);
  const fromShotRef = useRef<(file: File) => void>(() => {});

  const loadBoard = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    if (!opts?.silent) setError(null);
    try {
      const res = await fetch(
        `/api/sector-rotation?range=${encodeURIComponent(range)}`,
        { cache: "no-store" },
      );
      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        as_of?: string | null;
        bench_label?: string;
        sectors?: Card[];
      };
      if (!res.ok || json.ok === false) {
        throw new Error(json.error || `HTTP ${res.status}`);
      }
      setAsOf(json.as_of ?? null);
      setBenchLabel(json.bench_label || "Nifty 500");
      setCards(json.sectors ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!opts?.silent) setLoading(false);
    }
  }, [range]);

  const loadDetail = useCallback(
    async (id: string) => {
      setError(null);
      try {
        const res = await fetch(
          `/api/sector-rotation?id=${encodeURIComponent(id)}&range=${encodeURIComponent(range)}`,
          { cache: "no-store" },
        );
        const json = (await res.json()) as {
          ok?: boolean;
          error?: string;
          card?: Card;
          members?: Member[];
        };
        if (!res.ok || json.ok === false || !json.card) {
          throw new Error(json.error || `HTTP ${res.status}`);
        }
        setDetail({ card: json.card, members: json.members ?? [] });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [range],
  );

  useEffect(() => {
    void loadBoard();
  }, [loadBoard]);

  useEffect(() => {
    if (openId) void loadDetail(openId);
  }, [openId, loadDetail]);

  useEffect(() => {
    const q = addQ.trim();
    if (!openId || q.length < 1) {
      setHits([]);
      return;
    }
    const t = window.setTimeout(() => {
      void fetch(`/api/tickers?q=${encodeURIComponent(q)}&limit=8`, {
        cache: "no-store",
      })
        .then((r) => r.json())
        .then((json: { hits?: Hit[] }) => setHits(json.hits ?? []))
        .catch(() => setHits([]));
    }, 160);
    return () => window.clearTimeout(t);
  }, [addQ, openId]);

  const create = async () => {
    const label = newName.replace(/\s+/g, " ").trim();
    if (label.length < 2 || creating) return;
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/sector-rotation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ create: true, label }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        sector?: { id: string };
      };
      if (!res.ok || !json.sector?.id) {
        throw new Error(json.error || `HTTP ${res.status}`);
      }
      setNewName("");
      setOpenId(json.sector.id);
      await loadBoard();
      await loadDetail(json.sector.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  const runScreenshot = useCallback(async (file: File) => {
    if (file.type && !file.type.startsWith("image/") && file.type) return;
    if (shotUrl.current) URL.revokeObjectURL(shotUrl.current);
    const url = URL.createObjectURL(file);
    shotUrl.current = url;
    setShotPreview(url);
    setError(null);
    setShotLog((prev) => [
      ...prev,
      `— Screenshot (${file.name || "paste"}) —`,
      "Reading screenshot…",
    ]);
    const pushLog = (line: string) =>
      setShotLog((prev) => [...prev, line]);
    try {
      const form = new FormData();
      form.set("file", file);
      const res = await fetch("/api/sector-rotation/screenshot", {
        method: "POST",
        body: form,
      });
      if (!res.body) throw new Error("No progress stream");
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let donePayload: {
        industry?: string;
        unresolved?: string[];
        sector?: { id: string; label: string; members?: unknown[] };
      } | null = null;
      let streamError: string | null = null;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n");
        buf = parts.pop() ?? "";
        for (const raw of parts) {
          const line = raw.trim();
          if (!line) continue;
          let ev: {
            t?: string;
            industry?: string;
            names?: string[];
            query?: string;
            ticker?: string;
            name?: string;
            label?: string;
            n?: number;
            extracted?: number;
            resolved?: number;
            unresolved?: string[] | number;
            before?: number;
            after?: number;
            error?: string;
            sector?: { id: string; label: string; members?: unknown[] };
          };
          try {
            ev = JSON.parse(line) as typeof ev;
          } catch {
            continue;
          }
          if (ev.t === "ocr") pushLog("OCR…");
          else if (ev.t === "parsed") {
            pushLog(
              `Industry “${ev.industry}” · ${ev.names?.length ?? 0} names`,
            );
          } else if (ev.t === "hit") {
            pushLog(`${ev.query} → ${ev.ticker}`);
          } else if (ev.t === "dup") {
            pushLog(`${ev.query} already ${ev.ticker}`);
          } else if (ev.t === "miss") {
            pushLog(`Unresolved: ${ev.query}`);
          } else if (ev.t === "count") {
            const extracted = ev.extracted ?? 0;
            const resolved = ev.resolved ?? 0;
            const missed = typeof ev.unresolved === "number" ? ev.unresolved : 0;
            const before = ev.before ?? 0;
            const after = ev.after ?? 0;
            const added = Math.max(0, after - before);
            pushLog(
              `Count: OCR ${extracted} · matched ${resolved} · missed ${missed} · basket ${before} → ${after} (+${added})`,
            );
            if (extracted !== resolved + missed) {
              pushLog(
                `Count mismatch: OCR ${extracted} vs matched+missed ${resolved + missed}`,
              );
            }
          } else if (ev.t === "save") {
            pushLog(`Saved ${ev.n} stocks in “${ev.label}”`);
          } else if (ev.t === "done") {
            donePayload = {
              industry: ev.industry,
              unresolved: ev.unresolved,
              sector: ev.sector,
            };
          } else if (ev.t === "error") {
            streamError = ev.error || "Extract failed";
            pushLog(streamError);
          }
        }
      }
      if (streamError) throw new Error(streamError);
      const json = donePayload;
      if (!json?.sector?.id) {
        throw new Error("Screenshot import did not finish");
      }
      setNewName("");
      setOpenId(json.sector.id);
      const miss = (json.unresolved || []).filter(Boolean);
      if (miss.length) {
        setError(`Unresolved: ${miss.join(", ")}`);
      }
      const saved = (json.sector.members ?? []) as Array<{
        ticker?: string;
        name?: string;
        market?: string;
      }>;
      if (saved.length) {
        setDetail({
          card: {
            id: json.sector.id,
            label: json.sector.label,
            n: saved.length,
            sector_pct: null,
            bench_pct: null,
            sector: [],
            bench: [],
          },
          members: saved
            .filter((m) => (m.ticker || "").trim())
            .map((m) => ({
              ticker: String(m.ticker).toUpperCase(),
              name: m.name || String(m.ticker),
              market: m.market || "NSE",
              mcap_cr: null,
              price: null,
              change_pct: null,
              window_pct: null,
              spark: [],
              tv_url: "",
            })),
        });
      }
      pushLog("Refreshing board…");
      await Promise.all([
        loadBoard({ silent: true }),
        loadDetail(json.sector.id),
      ]);
      pushLog("Done");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setShotLog((prev) => [...prev, `Failed: ${msg}`]);
    }
  }, [loadBoard, loadDetail]);

  const enqueueShot = useCallback((file: File) => {
    if (file.type && !file.type.startsWith("image/") && file.type) return;
    shotQueue.current.push(file);
    setShotQueued(shotQueue.current.length);
    if (shotRunning.current) return;
    shotRunning.current = true;
    setShotBusy(true);
    void (async () => {
      try {
        while (shotQueue.current.length) {
          const next = shotQueue.current.shift()!;
          setShotQueued(shotQueue.current.length);
          await runScreenshot(next);
        }
      } finally {
        shotRunning.current = false;
        setShotBusy(false);
      }
    })();
  }, [runScreenshot]);

  fromShotRef.current = (file: File) => {
    enqueueShot(file);
  };

  useEffect(() => {
    shotWell.current?.focus();
  }, []);

  useEffect(() => {
    function imageFromPaste(e: ClipboardEvent): File | null {
      const cd = e.clipboardData;
      if (!cd) return null;
      for (const item of [...cd.items]) {
        if (!item.type.startsWith("image/")) continue;
        const f = item.getAsFile();
        if (f) return f;
      }
      for (const f of [...cd.files]) {
        if (f.type.startsWith("image/") || !f.type) return f;
      }
      return null;
    }
    function onDocPaste(e: ClipboardEvent) {
      const file = imageFromPaste(e);
      if (!file) return;
      e.preventDefault();
      fromShotRef.current(file);
    }
    window.addEventListener("paste", onDocPaste);
    return () => window.removeEventListener("paste", onDocPaste);
  }, []);

  const addTicker = async (h: Hit) => {
    if (!openId) return;
    setError(null);
    const res = await fetch("/api/sector-rotation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: openId,
        add: true,
        ticker: h.ticker,
        name: h.name,
        market: h.market || "NSE",
      }),
    });
    const json = (await res.json()) as { ok?: boolean; error?: string };
    if (!res.ok || json.ok === false) {
      setError(json.error || `HTTP ${res.status}`);
      return;
    }
    setAddQ("");
    setHits([]);
    await Promise.all([loadBoard({ silent: true }), loadDetail(openId)]);
  };

  const removeTicker = async (ticker: string) => {
    if (!openId) return;
    await fetch("/api/sector-rotation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: openId, remove: true, ticker }),
    });
    await Promise.all([loadBoard({ silent: true }), loadDetail(openId)]);
  };

  const openCard = detail?.card;
  const sortedCards = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return [...cards]
      .filter(
        (c) =>
          !needle ||
          c.label.toLowerCase().includes(needle),
      )
      .sort((a, b) => (b.sector_pct ?? -999) - (a.sector_pct ?? -999));
  }, [cards, filter]);
  const shownMembers = useMemo(() => {
    const needle = memberQ.trim().toLowerCase();
    const rows = detail?.members ?? [];
    if (!needle) return rows;
    return rows.filter(
      (m) =>
        m.ticker.toLowerCase().includes(needle) ||
        m.name.toLowerCase().includes(needle),
    );
  }, [detail, memberQ]);

  const closeSector = useCallback(() => {
    setOpenId(null);
    setDetail(null);
    setAddQ("");
    setHits([]);
    setMemberQ("");
    setEditLabel("");
  }, []);

  useEffect(() => {
    if (openCard?.label) setEditLabel(openCard.label);
  }, [openCard?.label, openId]);

  const saveLabel = async () => {
    const label = editLabel.replace(/\s+/g, " ").trim();
    if (!openId || label.length < 2 || label === openCard?.label) return;
    const res = await fetch("/api/sector-rotation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: openId, rename: true, label }),
    });
    const json = (await res.json()) as { ok?: boolean; error?: string };
    if (!res.ok || json.ok === false) {
      setError(json.error || `HTTP ${res.status}`);
      return;
    }
    await Promise.all([loadBoard({ silent: true }), loadDetail(openId)]);
  };

  const deleteOpenSector = async () => {
    if (!openId) return;
    const label = (editLabel || openCard?.label || "this sector").trim();
    if (!window.confirm(`Delete sector “${label}”?`)) return;
    const res = await fetch("/api/sector-rotation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: openId, deleteSector: true }),
    });
    const json = (await res.json()) as { ok?: boolean; error?: string };
    if (!res.ok || json.ok === false) {
      setError(json.error || `HTTP ${res.status}`);
      return;
    }
    closeSector();
    await loadBoard({ silent: true });
  };

  useEffect(() => {
    if (!openId) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      closeSector();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openId, closeSector]);

  return (
    <section className="rot-dash">
      <header className="rot-head">
        <div>
          <h2 className="rot-title">Sector rotation</h2>
          <p className="rot-sub">
            Equal-weight indexes vs {benchLabel}, rebased to 100
            {asOf ? ` · EOD ${asOf}` : ""}. Search and add listings from the
            book or Groww.
          </p>
          {openId ? (
            <button
              type="button"
              className="btn-ghost rot-back"
              onClick={closeSector}
            >
              ← Back to sectors
            </button>
          ) : null}
        </div>
        <div className="rot-ranges" role="group" aria-label="Range">
          {ROTATION_RANGES.map((r) => (
            <button
              key={r}
              type="button"
              className={range === r ? "tab on" : "tab"}
              onClick={() => setRange(r)}
            >
              {r}
            </button>
          ))}
          <button
            type="button"
            className={view === "grid" ? "tab on" : "tab"}
            onClick={() => setView("grid")}
          >
            Grid
          </button>
          <button
            type="button"
            className={view === "table" ? "tab on" : "tab"}
            onClick={() => setView("table")}
          >
            Table
          </button>
          <button type="button" className="btn-ghost" onClick={() => void loadBoard()}>
            {loading ? "Loading…" : "Refresh"}
          </button>
        </div>
      </header>

      <form
        className="rot-create"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <input
          className="fam-dash-search"
          placeholder="New sector name…"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          aria-label="New sector name"
        />
        <button
          type="submit"
          className="btn-ghost"
          disabled={creating || newName.trim().length < 2}
        >
            {creating ? "Saving…" : "Create sector"}
        </button>
        {!openId ? (
          <input
            className="fam-dash-search"
            placeholder="Search sector…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="Search sector"
          />
        ) : null}
      </form>

      <div
        ref={shotWell}
        className={`din-paste-well rot-shot${shotDrag ? " is-drag" : ""}${shotBusy ? " is-busy" : ""}`}
        tabIndex={0}
        role="button"
        aria-label="Paste sector screenshot"
        onClick={() => shotWell.current?.focus()}
        onPaste={(e) => {
          const file =
            [...e.clipboardData.items]
              .find((i) => i.type.startsWith("image/"))
              ?.getAsFile() ??
            [...e.clipboardData.files].find((f) => f.type.startsWith("image/")) ??
            null;
          if (file) {
            e.preventDefault();
            void enqueueShot(file);
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setShotDrag(true);
        }}
        onDragLeave={() => setShotDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setShotDrag(false);
          const file = e.dataTransfer.files[0];
          if (file) void enqueueShot(file);
        }}
      >
        {shotPreview ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="din-paste-preview rot-shot-preview" src={shotPreview} alt="" />
            <label className="din-paste-upload">
              Add more images
              <input
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(e) => {
                  const files = [...(e.target.files ?? [])];
                  for (const f of files) enqueueShot(f);
                  e.target.value = "";
                }}
              />
            </label>
          </>
        ) : (
          <div className="din-paste-hint">
            <strong>Paste screener screenshots</strong>
            <span>
              Same industry merges. Paste the next page while this one runs.
            </span>
            <label className="din-paste-upload">
              Choose images
              <input
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(e) => {
                  const files = [...(e.target.files ?? [])];
                  for (const f of files) enqueueShot(f);
                  e.target.value = "";
                }}
              />
            </label>
          </div>
        )}
        {shotBusy ? (
          <p className="din-paste-busy">
            {shotLog[shotLog.length - 1] || "Working…"}
            {shotQueued ? ` · ${shotQueued} waiting` : ""}
          </p>
        ) : null}
      </div>
      {shotLog.length ? (
        <ol className="rot-shot-log" aria-live="polite">
          {shotLog.map((line, i) => (
            <li key={`${i}-${line.slice(0, 24)}`}>{line}</li>
          ))}
        </ol>
      ) : null}

      {error ? <div className="table-meta">{error}</div> : null}

      {openId ? (
        <div className="rot-detail">
          <div className="rot-detail-bar">
            <button type="button" className="btn-ghost rot-back" onClick={closeSector}>
              ← Back
            </button>
            <input
              className="fam-dash-search rot-rename"
              value={editLabel}
              onChange={(e) => setEditLabel(e.target.value)}
              onBlur={() => void saveLabel()}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void saveLabel();
                }
              }}
              aria-label="Sector name"
            />
            <span className="rot-pct">{fmtPct(openCard?.sector_pct ?? null)}</span>
            <span className="rot-muted">
              {benchLabel} {fmtPct(openCard?.bench_pct ?? null)}
              {openCard ? ` · ${openCard.n} stocks` : ""}
            </span>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => void deleteOpenSector()}
            >
              Delete sector
            </button>
          </div>
          {openCard ? (
            <DualSpark
              a={openCard.sector}
              b={openCard.bench}
              height={160}
              aLabel={openCard.label}
              bLabel={benchLabel}
            />
          ) : (
            <div className="table-meta">Loading sector…</div>
          )}
          <div className="rot-add gov-family-add">
            <input
              type="search"
              className="gov-family-add-input"
              placeholder="Add stock (name or ticker)…"
              value={addQ}
              onChange={(e) => setAddQ(e.target.value)}
            />
            {hits.length ? (
              <ul className="gov-family-add-hits">
                {hits.map((h) => (
                  <li key={h.ticker}>
                    <button type="button" onClick={() => void addTicker(h)}>
                      <span className="mono">{h.ticker}</span>
                      <span>
                        {h.name}
                        {h.source === "groww" ? " · Groww" : ""}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          <input
            className="fam-dash-search rot-member-filter"
            placeholder="Search by name or code…"
            value={memberQ}
            onChange={(e) => setMemberQ(e.target.value)}
            aria-label="Filter constituents"
          />
          <table className="rot-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Stock name</th>
                <th>Symbol</th>
                <th>Mcap</th>
                <th>Price</th>
                <th>Today %</th>
                <th>Change %</th>
                <th>Trend</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shownMembers.map((m, i) => (
                <tr key={m.ticker}>
                  <td>{i + 1}</td>
                  <td>
                    <a href={m.tv_url} target="_blank" rel="noopener noreferrer">
                      {m.name}
                    </a>
                  </td>
                  <td className="mono">{m.ticker}</td>
                  <td>{fmtCr(m.mcap_cr)}</td>
                  <td>
                    {m.price != null
                      ? `₹${m.price.toLocaleString("en-IN")}`
                      : "—"}
                  </td>
                  <td className={(m.change_pct ?? 0) >= 0 ? "pos" : "neg"}>
                    {fmtPct(m.change_pct)}
                  </td>
                  <td className={(m.window_pct ?? 0) >= 0 ? "pos" : "neg"}>
                    {fmtPct(m.window_pct)}
                  </td>
                  <td>
                    <MiniSpark pts={m.spark} />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn-ghost"
                      onClick={() => void removeTicker(m.ticker)}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : view === "table" ? (
        <table className="rot-table">
          <thead>
            <tr>
              <th>Sector</th>
              <th>Stocks</th>
              <th>Return</th>
              <th>{benchLabel}</th>
            </tr>
          </thead>
          <tbody>
            {sortedCards.map((c) => (
              <tr key={c.id} className="rot-row" onClick={() => setOpenId(c.id)}>
                <td>{c.label}</td>
                <td>{c.n}</td>
                <td className={(c.sector_pct ?? 0) >= 0 ? "pos" : "neg"}>
                  {fmtPct(c.sector_pct)}
                </td>
                <td>{fmtPct(c.bench_pct)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="rot-grid">
          {loading && !cards.length ? (
            <div className="table-meta">Loading sectors…</div>
          ) : null}
          {sortedCards.map((c) => (
            <button
              key={c.id}
              type="button"
              className="rot-card"
              onClick={() => setOpenId(c.id)}
            >
              <div className="rot-card-top">
                <strong>{c.label}</strong>
                <span className={(c.sector_pct ?? 0) >= 0 ? "pos" : "neg"}>
                  {fmtPct(c.sector_pct)}
                </span>
              </div>
              <div className="rot-muted">
                <span className="rot-count">{c.n} stocks</span>
                {" · "}
                {benchLabel} {fmtPct(c.bench_pct)}
              </div>
              <DualSpark
                a={c.sector}
                b={c.bench}
                height={110}
                aLabel={c.label}
                bLabel={benchLabel}
              />
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
