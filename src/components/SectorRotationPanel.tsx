"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TickerSuggest, type TickerSuggestHit } from "@/components/TickerSuggest";
import { ROTATION_MA_PERIODS, ROTATION_RANGES } from "@/lib/sector-rotation-series";

type Point = { date: string; value: number };

type Card = {
  id: string;
  label: string;
  n: number;
  up?: number;
  down?: number;
  starred?: boolean;
  sector_pct: number | null;
  bench_pct: number | null;
  today_pct?: number | null;
  search?: string;
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

function sma(pts: Point[], n: number): Point[] {
  if (n < 2 || pts.length < n) return [];
  const out: Point[] = [];
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    sum += pts[i]!.value;
    if (i >= n) sum -= pts[i - n]!.value;
    if (i >= n - 1) {
      out.push({ date: pts[i]!.date, value: sum / n });
    }
  }
  return out;
}

function DualSpark({
  a,
  b,
  width = 320,
  height = 120,
  showEnd = true,
  aLabel = "Sector",
  bLabel = "Nifty",
  logScale = false,
  ma = [],
}: {
  a: Point[];
  b: Point[];
  width?: number;
  height?: number;
  showEnd?: boolean;
  aLabel?: string;
  bLabel?: string;
  logScale?: boolean;
  ma?: number[];
}) {
  const [hover, setHover] = useState<number | null>(null);
  const plotFrom = b[0]?.date ?? a[0]?.date ?? "";
  const firstVis = a.find((p) => !plotFrom || p.date >= plotFrom);
  const k = firstVis && firstVis.value > 0 ? 100 / firstVis.value : 1;
  const scaledA = a.map((p) => ({ date: p.date, value: p.value * k }));
  const visA = scaledA.filter((p) => !plotFrom || p.date >= plotFrom);
  const visB = b;
  const dates = [...new Set([...visA, ...visB].map((p) => p.date))].sort();
  const mapA = new Map(visA.map((p) => [p.date, p.value]));
  const mapB = new Map(visB.map((p) => [p.date, p.value]));
  const maLines = ma.map((n) => ({
    n,
    pts: sma(scaledA, n).filter((p) => !plotFrom || p.date >= plotFrom),
  }));
  const ys = [
    ...visA,
    ...visB,
    ...maLines.flatMap((m) => m.pts),
  ].map((p) => p.value);
  const rawLo = Math.min(...ys, 80);
  const rawHi = Math.max(...ys, 120);
  const yMap = (v: number) => {
    if (!logScale) return v;
    return Math.log(Math.max(v, 1e-6));
  };
  const lo = yMap(rawLo);
  const hi = yMap(rawHi);
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
    height - 14 - ((yMap(v) - y0) / (y1 - y0)) * (height - 22);
  const line = (pts: Point[]) =>
    pts.length < 2
      ? ""
      : pts
          .map(
            (p, i) =>
              `${i === 0 ? "M" : "L"}${xAt(p.date).toFixed(1)} ${yAt(p.value).toFixed(1)}`,
          )
          .join(" ");
  const lastA = visA[visA.length - 1];
  const lastB = visB[visB.length - 1];
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
        {line(visB) ? (
          <path
            d={line(visB)}
            fill="none"
            stroke="#94a3b8"
            strokeDasharray="3 3"
            strokeWidth="1.5"
          />
        ) : null}
        {maLines.map((m) =>
          line(m.pts) ? (
            <path
              key={m.n}
              d={line(m.pts)}
              fill="none"
              stroke={m.n === 20 ? "#38bdf8" : m.n === 50 ? "#a78bfa" : "#f59e0b"}
              strokeWidth="1.2"
              opacity="0.85"
            />
          ) : null,
        )}
        {line(visA) ? (
          <path d={line(visA)} fill="none" stroke="#22c55e" strokeWidth="2" />
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
  const [newTickers, setNewTickers] = useState<Hit[]>([]);
  const [newQ, setNewQ] = useState("");
  const [adding, setAdding] = useState(false);
  const [addQ, setAddQ] = useState("");
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState("");
  const [stockFilter, setStockFilter] = useState("");
  const [boardFilter, setBoardFilter] = useState<
    "all" | "top" | "bottom" | "starred"
  >("all");
  const [aboveOn, setAboveOn] = useState(false);
  const [sortKey, setSortKey] = useState<"return" | "today" | "name" | "n">(
    "return",
  );
  const [scale, setScale] = useState<"lin" | "log">("lin");
  const [maOn, setMaOn] = useState<number[]>([]);
  const [weight, setWeight] = useState<"equal" | "cap">("equal");
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
        `/api/sector-rotation?range=${encodeURIComponent(range)}&weight=${encodeURIComponent(weight)}`,
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
  }, [range, weight]);

  const loadDetail = useCallback(
    async (id: string) => {
      setError(null);
      try {
        const res = await fetch(
          `/api/sector-rotation?id=${encodeURIComponent(id)}&range=${encodeURIComponent(range)}&weight=${encodeURIComponent(weight)}`,
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
    [range, weight],
  );

  useEffect(() => {
    void loadBoard();
  }, [loadBoard]);

  useEffect(() => {
    if (openId) void loadDetail(openId);
  }, [openId, loadDetail]);

  const pickCreateTicker = (h: TickerSuggestHit) => {
    setNewTickers((rows) =>
      rows.some((x) => x.ticker === h.ticker) ? rows : [...rows, h],
    );
    setNewQ("");
  };

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
      setNewTickers([]);
      setNewQ("");
      setAdding(false);
      setOpenId(json.sector.id);
      for (const h of newTickers) {
        await fetch("/api/sector-rotation", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: json.sector.id,
            add: true,
            ticker: h.ticker,
            name: h.name,
            market: h.market || "NSE",
          }),
        });
      }
      await loadBoard();
      await loadDetail(json.sector.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  const runScreenshot = useCallback(async (file: File, priorIndustry = "") => {
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
      if (priorIndustry) form.set("priorIndustry", priorIndustry);
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
          if (ev.t === "ocr") {
            setShotLog((prev) => {
              const last = prev[prev.length - 1] || "";
              if (last.startsWith("OCR")) {
                return [...prev, "OCR still running (vision model)…"];
              }
              return [...prev, "OCR (vision; often 30–90s)…"];
            });
          }
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
      return (
        json.industry ||
        json.sector.label ||
        ""
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setShotLog((prev) => [...prev, `Failed: ${msg}`]);
      return "";
    }
  }, [loadBoard, loadDetail]);

  const enqueueShot = useCallback((file: File) => {
    if (file.type && !file.type.startsWith("image/") && file.type) return;
    setAdding(true);
    shotQueue.current.push(file);
    setShotQueued(shotQueue.current.length);
    if (shotRunning.current) return;
    shotRunning.current = true;
    setShotBusy(true);
    void (async () => {
      let batchIndustry = "";
      try {
        while (shotQueue.current.length) {
          const next = shotQueue.current.shift()!;
          setShotQueued(shotQueue.current.length);
          const label = await runScreenshot(next, batchIndustry);
          if (label) batchIndustry = label;
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
    setAddQ("");
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
    await loadDetail(openId);
    void loadBoard({ silent: true });
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
    const stock = stockFilter.trim().toLowerCase();
    let rows = [...cards].filter((c) => {
      if (needle && !c.label.toLowerCase().includes(needle)) return false;
      if (stock && !(c.search || "").includes(stock) && !c.label.toLowerCase().includes(stock)) {
        return false;
      }
      return true;
    });
    rows.sort((a, b) => {
      if (sortKey === "today") return (b.today_pct ?? -999) - (a.today_pct ?? -999);
      if (sortKey === "name") return a.label.localeCompare(b.label);
      if (sortKey === "n") return b.n - a.n;
      return (b.sector_pct ?? -999) - (a.sector_pct ?? -999);
    });
    if (boardFilter === "starred") rows = rows.filter((c) => c.starred);
    if (aboveOn) {
      rows = rows.filter(
        (c) =>
          c.sector_pct != null &&
          c.bench_pct != null &&
          c.sector_pct > c.bench_pct,
      );
    }
    if (boardFilter === "top") rows = rows.slice(0, 20);
    if (boardFilter === "bottom") rows = rows.slice(-20).reverse();
    return rows;
  }, [cards, filter, stockFilter, boardFilter, aboveOn, sortKey]);
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

  const toggleStar = async (id: string, next: boolean) => {
    setCards((prev) =>
      prev.map((c) => (c.id === id ? { ...c, starred: next } : c)),
    );
    await fetch("/api/sector-rotation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, star: true, starred: next }),
    });
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
          <h2 className="rot-title">All Sectors Dashboard</h2>
          <p className="rot-sub">
            {weight === "cap" ? "Free-float cap" : "Equal-weight"} vs {benchLabel}
            {asOf ? ` · as of ${asOf}` : ""}
            {loading ? " · loading…" : ""}
          </p>
          {openId ? (
            <button
              type="button"
              className="btn-ghost rot-back"
              onClick={closeSector}
            >
              ← Back to sectors
            </button>
          ) : (
            <button
              type="button"
              className="btn-ghost"
              onClick={() => setAdding((v) => !v)}
            >
              {adding ? "Cancel" : "Add sector"}
            </button>
          )}
        </div>
      </header>

      <div className="rot-bar">
        <div className="rot-bar-row">
          <button
            type="button"
            className="rot-chip"
            onClick={() => void loadBoard()}
          >
            ↻ Refresh
          </button>
          <span className="rot-bar-sep" />
          <button
            type="button"
            className={view === "grid" ? "rot-chip on" : "rot-chip"}
            onClick={() => setView("grid")}
          >
            Grid
          </button>
          <button
            type="button"
            className={view === "table" ? "rot-chip on" : "rot-chip"}
            onClick={() => setView("table")}
          >
            Table
          </button>
          <span className="rot-bar-k">Scale</span>
          <button
            type="button"
            className={scale === "lin" ? "rot-chip on" : "rot-chip"}
            onClick={() => setScale("lin")}
          >
            Lin
          </button>
          <button
            type="button"
            className={scale === "log" ? "rot-chip on" : "rot-chip"}
            onClick={() => setScale("log")}
          >
            Log
          </button>
          <span className="rot-bar-k">MA</span>
          {ROTATION_MA_PERIODS.map((n) => (
            <button
              key={n}
              type="button"
              className={maOn.includes(n) ? "rot-chip on" : "rot-chip"}
              onClick={() =>
                setMaOn((prev) =>
                  prev.includes(n)
                    ? prev.filter((x) => x !== n)
                    : [...prev, n].sort((a, b) => a - b),
                )
              }
            >
              {n}
            </button>
          ))}
          <span className="rot-bar-k">Index type</span>
          <button
            type="button"
            className={weight === "equal" ? "rot-chip on" : "rot-chip"}
            onClick={() => setWeight("equal")}
          >
            Equal Weight
          </button>
          <button
            type="button"
            className={weight === "cap" ? "rot-chip on" : "rot-chip"}
            onClick={() => setWeight("cap")}
          >
            Free-Float Cap
          </button>
          <span className="rot-bar-sep" />
          {ROTATION_RANGES.map((r) => (
            <button
              key={r}
              type="button"
              className={range === r ? "rot-chip on" : "rot-chip"}
              onClick={() => setRange(r)}
            >
              {r}
            </button>
          ))}
        </div>
        {!openId ? (
          <div className="rot-bar-row">
            <span className="rot-bar-k">Search</span>
            <input
              className="rot-bar-search"
              placeholder="Search sector or industry"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              aria-label="Search sector"
            />
            <input
              className="rot-bar-search"
              placeholder="Search stock (name, NS)"
              value={stockFilter}
              onChange={(e) => setStockFilter(e.target.value)}
              aria-label="Search stock"
            />
            <span className="rot-bar-k">Filter</span>
            {(
              [
                ["all", "All"],
                ["top", "Top 20"],
                ["bottom", "Bottom 20"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={boardFilter === id ? "rot-chip on" : "rot-chip"}
                onClick={() => setBoardFilter(id)}
              >
                {label}
              </button>
            ))}
            <button
              type="button"
              className={aboveOn ? "rot-chip on" : "rot-chip"}
              onClick={() => setAboveOn((v) => !v)}
            >
              Above: {aboveOn ? "On" : "Off"}
            </button>
            <button
              type="button"
              className={boardFilter === "starred" ? "rot-chip on" : "rot-chip"}
              onClick={() =>
                setBoardFilter((v) => (v === "starred" ? "all" : "starred"))
              }
            >
              ★ Starred
            </button>
            <span className="rot-bar-k">Sort</span>
            <select
              className="rot-bar-sort"
              value={sortKey}
              onChange={(e) =>
                setSortKey(e.target.value as typeof sortKey)
              }
              aria-label="Sort"
            >
              <option value="return">Return</option>
              <option value="today">Today</option>
              <option value="name">Name</option>
              <option value="n">Stocks</option>
            </select>
          </div>
        ) : null}
      </div>

      {!openId && adding ? (
      <form
        className="fam-dash-create"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <div className="rot-create-top">
        <input
          className="fam-dash-search"
          placeholder="Sector name"
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
        </div>
        <div className="fam-dash-create-cos">
          {newTickers.map((t) => (
            <span key={t.ticker} className="fam-dash-create-chip">
              <span className="mono">{t.ticker}</span>
              <button
                type="button"
                title={`Remove ${t.ticker}`}
                onClick={() =>
                  setNewTickers((rows) =>
                    rows.filter((x) => x.ticker !== t.ticker),
                  )
                }
              >
                ×
              </button>
            </span>
          ))}
          <TickerSuggest
            value={newQ}
            onChange={setNewQ}
            onSelect={pickCreateTicker}
            clearOnSelect
            persistGroww={false}
            placeholder="Add company…"
            className="fam-dash-search"
            submitLabel="add"
          />
        </div>
        <div
          ref={shotWell}
          className={`din-paste-well rot-shot rot-shot-mini${shotDrag ? " is-drag" : ""}${shotBusy ? " is-busy" : ""}`}
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
                Add images
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
              <span>Or paste / drop a screener screenshot</span>
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
      </form>
      ) : null}
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
              logScale={scale === "log"}
              ma={maOn}
            />
          ) : (
            <div className="table-meta">Loading sector…</div>
          )}
          <TickerSuggest
            value={addQ}
            onChange={setAddQ}
            onSelect={(h) => void addTicker(h)}
            clearOnSelect
            persistGroww={false}
            placeholder="Add company…"
            className="fam-dash-search"
            submitLabel="add"
          />
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
              <th></th>
              <th>Sector</th>
              <th>Stocks</th>
              <th>Today</th>
              <th>Return</th>
              <th>{benchLabel}</th>
            </tr>
          </thead>
          <tbody>
            {sortedCards.map((c) => (
              <tr key={c.id} className="rot-row" onClick={() => setOpenId(c.id)}>
                <td>
                  <button
                    type="button"
                    className={c.starred ? "rot-star on" : "rot-star"}
                    onClick={(e) => {
                      e.stopPropagation();
                      void toggleStar(c.id, !c.starred);
                    }}
                  >
                    ★
                  </button>
                </td>
                <td>{c.label}</td>
                <td>
                  {c.n}
                  {(c.up ?? 0) > 0 ? (
                    <span className="rot-up">▲ {c.up}</span>
                  ) : null}
                  {(c.down ?? 0) > 0 ? (
                    <span className="rot-dn">▼ {c.down}</span>
                  ) : null}
                </td>
                <td className={(c.today_pct ?? 0) >= 0 ? "pos" : "neg"}>
                  {fmtPct(c.today_pct ?? null)}
                </td>
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
            <article
              key={c.id}
              className="rot-card"
              tabIndex={0}
              role="button"
              onClick={() => setOpenId(c.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setOpenId(c.id);
                }
              }}
            >
              <div className="rot-card-top">
                <strong>{c.label}</strong>
                <span className="rot-card-ret">
                  <span className={(c.sector_pct ?? 0) >= 0 ? "pos" : "neg"}>
                    {fmtPct(c.sector_pct)}
                  </span>
                  <button
                    type="button"
                    className={c.starred ? "rot-star on" : "rot-star"}
                    aria-label={c.starred ? "Unstar" : "Star"}
                    onClick={(e) => {
                      e.stopPropagation();
                      void toggleStar(c.id, !c.starred);
                    }}
                  >
                    ★
                  </button>
                </span>
              </div>
              <div className="rot-muted">
                <span className="rot-count">{c.n} stocks</span>
                {(c.up ?? 0) > 0 ? (
                  <span className="rot-up">▲ {c.up}</span>
                ) : null}
                {(c.down ?? 0) > 0 ? (
                  <span className="rot-dn">▼ {c.down}</span>
                ) : null}
                <span className={(c.today_pct ?? 0) >= 0 ? "pos" : "neg"}>
                  Today {fmtPct(c.today_pct ?? null)}
                </span>
              </div>
              <DualSpark
                a={c.sector}
                b={c.bench}
                height={110}
                aLabel={c.label}
                bLabel={benchLabel}
                logScale={scale === "log"}
                ma={maOn}
              />
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
