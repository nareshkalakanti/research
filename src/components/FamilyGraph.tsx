"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type Company = {
  ticker: string;
  name: string;
  cap_code?: string | null;
  market_cap_cr?: number | null;
  directors?: number;
  din_verified?: number;
};

type Person = {
  person_id: string;
  name: string;
  din: string | null;
  tickers: string[];
  dir_score?: number;
};

type Outside = { ticker: string; name: string; cap_code?: string | null; market_cap_cr?: number | null };

type NodeKind = "company" | "person" | "outside";

type GraphNode = {
  id: string;
  kind: NodeKind;
  label: string;
  title: string;
  hint: string;
  cap: string | null;
  r: number;
  x: number;
  y: number;
};

const WIDE_ASPECT = 2.6;

const RADIUS: Record<NodeKind, number> = { company: 16, outside: 12, person: 8 };
const MIN_VIEW_W = 360;
const MIN_VIEW_H = 220;

const CAP_LEGEND = [
  ["lc", "Large"],
  ["mc", "Mid"],
  ["sc", "Small"],
  ["sub500", "Under ₹500 Cr"],
] as const;

function fmtMcapCr(cr: number | null | undefined): string {
  const n = cr == null ? NaN : Number(cr);
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n >= 10_000) return `₹${(n / 1000).toFixed(1)}k Cr`;
  if (n >= 100) return `₹${Math.round(n).toLocaleString("en-IN")} Cr`;
  if (n >= 10) return `₹${n.toFixed(0)} Cr`;
  return `₹${n.toFixed(1)} Cr`;
}

function capLabel(cap: string | null): string {
  if (cap === "lc") return "Large";
  if (cap === "mc") return "Mid";
  if (cap === "sc") return "Small";
  if (cap === "sub500") return "Under ₹500 Cr";
  return "";
}

function listingTitle(
  ticker: string,
  name: string,
  opts: {
    cap: string | null;
    mcap: number | null | undefined;
    extra?: string;
  },
): { title: string; hint: string } {
  const mcap = fmtMcapCr(opts.mcap);
  const band = capLabel(opts.cap);
  const hint = [mcap, band].filter(Boolean).join(" · ");
  const bits = [ticker, name, opts.extra, hint].filter(Boolean);
  return { title: bits.join(" · "), hint };
}

function capBand(
  cap_code?: string | null,
  market_cap_cr?: number | null,
): string | null {
  const mcap = market_cap_cr == null ? null : Number(market_cap_cr);
  if (mcap != null && Number.isFinite(mcap) && mcap > 0 && mcap < 500) {
    return "sub500";
  }
  const cap = (cap_code || "").toLowerCase();
  if (cap === "ti" || cap === "mic") return "sub500";
  return cap || null;
}

function layout(
  nodes: GraphNode[],
  edges: Array<[number, number]>,
  width: number,
  height: number,
) {
  const n = nodes.length;
  if (!n) return;
  const cx = width / 2;
  const cy = height / 2;
  nodes.forEach((node, i) => {
    const angle = (i / n) * Math.PI * 2;
    const ring = node.kind === "company" ? 0.25 : node.kind === "person" ? 0.4 : 0.55;
    node.x = cx + Math.cos(angle) * width * ring;
    node.y = cy + Math.sin(angle) * height * ring;
  });
  const vx = new Float64Array(n);
  const vy = new Float64Array(n);
  const iterations = 320;
  for (let step = 0; step < iterations; step++) {
    const cool = 1 - step / iterations;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = nodes[i]!;
        const b = nodes[j]!;
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) {
          dx = Math.random() - 0.5;
          dy = Math.random() - 0.5;
          d2 = 0.25;
        }
        const minD = a.r + b.r + 14;
        const force = (1800 + minD * minD) / d2;
        const d = Math.sqrt(d2);
        const fx = (dx / d) * force;
        const fy = (dy / d) * force;
        vx[i]! += fx;
        vy[i]! += fy;
        vx[j]! -= fx;
        vy[j]! -= fy;
      }
    }
    for (const [i, j] of edges) {
      const a = nodes[i]!;
      const b = nodes[j]!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const target = a.r + b.r + 48;
      const k = (d - target) * 0.06;
      vx[i]! += (dx / d) * k * d * 0.1;
      vy[i]! += (dy / d) * k * d * 0.1;
      vx[j]! -= (dx / d) * k * d * 0.1;
      vy[j]! -= (dy / d) * k * d * 0.1;
    }
    for (let i = 0; i < n; i++) {
      const node = nodes[i]!;
      vx[i]! += (cx - node.x) * 0.004;
      vy[i]! += (cy - node.y) * 0.07;
      const max = 24 * cool + 1;
      node.x += Math.max(-max, Math.min(max, vx[i]! * 0.1));
      node.y += Math.max(-max, Math.min(max, vy[i]! * 0.1));
      vx[i] = 0;
      vy[i] = 0;
    }
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const a = nodes[i]!;
          const b = nodes[j]!;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
          const gap = 34;
          const minD = a.r + b.r + gap;
          if (d >= minD) continue;
          const push = (minD - d) / 2;
          const ux = dx / d;
          const uy = dy / d;
          a.x -= ux * push;
          a.y -= uy * push;
          b.x += ux * push;
          b.y += uy * push;
        }
      }
    }
  }
}

export function FamilyGraph({
  companies,
  people,
  outside,
  onCompany,
  onPerson,
  chartUrl,
}: {
  companies: Company[];
  people: Person[];
  outside: Outside[];
  onCompany: (ticker: string) => void;
  onPerson: (personId: string, name: string) => void;
  chartUrl?: (ticker: string) => string;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [dragged, setDragged] = useState<Record<string, { x: number; y: number }>>({});
  const [legendOn, setLegendOn] = useState<Set<string>>(() => new Set());
  const drag = useRef<{ id: string; moved: boolean } | null>(null);
  const justDragged = useRef(false);

  const { nodes, edges, view } = useMemo(() => {
    const list: GraphNode[] = [];
    const index = new Map<string, number>();
    const add = (node: GraphNode) => {
      if (index.has(node.id)) return;
      index.set(node.id, list.length);
      list.push(node);
    };
    for (const c of companies) {
      const cap = capBand(c.cap_code, c.market_cap_cr);
      const { title, hint } = listingTitle(c.ticker, c.name, {
        cap,
        mcap: c.market_cap_cr,
        extra: c.directors
          ? `DIN ${c.din_verified ?? 0}/${c.directors}`
          : undefined,
      });
      add({
        id: `c:${c.ticker}`,
        kind: "company",
        label: c.ticker,
        cap,
        title,
        hint,
        r: RADIUS.company,
        x: 0,
        y: 0,
      });
    }
    for (const o of outside) {
      const cap = capBand(o.cap_code, o.market_cap_cr);
      const { title, hint } = listingTitle(o.ticker, o.name, {
        cap,
        mcap: o.market_cap_cr,
        extra: "outside group",
      });
      add({
        id: `c:${o.ticker}`,
        kind: "outside",
        label: o.ticker,
        cap,
        title,
        hint,
        r: RADIUS.outside,
        x: 0,
        y: 0,
      });
    }
    const pairs: Array<[number, number]> = [];
    for (const p of people) {
      add({
        id: `p:${p.person_id}`,
        kind: "person",
        label: "",
        cap: null,
        title: `${p.name}${p.din ? ` · DIN ${p.din}` : ""} · ${p.tickers.length} boards`,
        hint: "",
        r: RADIUS.person,
        x: 0,
        y: 0,
      });
      const pi = index.get(`p:${p.person_id}`)!;
      for (const t of p.tickers) {
        const ci = index.get(`c:${t}`);
        if (ci != null) pairs.push([pi, ci]);
      }
    }
    const companyIdx = list
      .map((node, i) => (node.kind === "company" ? i : -1))
      .filter((i) => i >= 0);
    if (companyIdx.length > 1) {
      const hubTicker = [...companies].sort(
        (a, b) => (b.market_cap_cr ?? -1) - (a.market_cap_cr ?? -1),
      )[0]?.ticker;
      const hub = hubTicker != null ? index.get(`c:${hubTicker}`) : undefined;
      const touched = new Set<number>();
      for (const [a, b] of pairs) {
        touched.add(a);
        touched.add(b);
      }
      if (hub != null) {
        for (const ci of companyIdx) {
          if (ci === hub || touched.has(ci)) continue;
          const ticker = list[ci]!.id.replace(/^c:/, "");
          const linked = people.some((p) =>
            p.tickers.some((t) => t.toUpperCase() === ticker),
          );
          if (!linked) continue;
          pairs.push([hub, ci]);
        }
      }
    }
    const count = list.length;
    const width = Math.max(760, Math.sqrt(count) * 210);
    const height = Math.max(280, Math.sqrt(count) * 90);
    layout(list, pairs, width, height);
    if (list.length > 1) {
      const xs = list.map((node) => node.x);
      const ys = list.map((node) => node.y);
      const spanX = Math.max(...xs) - Math.min(...xs) || 1;
      const spanY = Math.max(...ys) - Math.min(...ys) || 1;
      const stretch = (spanY * WIDE_ASPECT) / spanX;
      if (stretch > 1) {
        const midX = (Math.max(...xs) + Math.min(...xs)) / 2;
        for (const node of list) node.x = midX + (node.x - midX) * stretch;
      }
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const node of list) {
      minX = Math.min(minX, node.x - node.r - 56);
      maxX = Math.max(maxX, node.x + node.r + 56);
      minY = Math.min(minY, node.y - node.r - 16);
      maxY = Math.max(maxY, node.y + node.r + 28);
    }
    if (!list.length) {
      minX = 0;
      minY = 0;
      maxX = MIN_VIEW_W;
      maxY = MIN_VIEW_H;
    }
    let viewW = Math.max(maxX - minX, 1);
    let viewH = Math.max(maxY - minY, 1);
    if (viewW < MIN_VIEW_W) {
      const mid = (minX + maxX) / 2;
      minX = mid - MIN_VIEW_W / 2;
      maxX = mid + MIN_VIEW_W / 2;
      viewW = MIN_VIEW_W;
    }
    if (viewH < MIN_VIEW_H) {
      const mid = (minY + maxY) / 2;
      minY = mid - MIN_VIEW_H / 2;
      maxY = mid + MIN_VIEW_H / 2;
      viewH = MIN_VIEW_H;
    }
    const companyR = Math.max(12, Math.min(20, viewW * 0.042));
    for (const node of list) {
      if (node.kind === "company") node.r = node.cap === "sub500" ? companyR * 1.2 : companyR;
      else if (node.kind === "outside") node.r = companyR * 0.78;
      else node.r = companyR * 0.5;
    }
    return {
      nodes: list,
      edges: pairs,
      view: { x: minX, y: minY, w: viewW, h: viewH },
    };
  }, [companies, people, outside]);

  const pos = (node: GraphNode) => dragged[node.id] ?? { x: node.x, y: node.y };

  const neighbours = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const [a, b] of edges) {
      const ida = nodes[a]!.id;
      const idb = nodes[b]!.id;
      if (!map.has(ida)) map.set(ida, new Set());
      if (!map.has(idb)) map.set(idb, new Set());
      map.get(ida)!.add(idb);
      map.get(idb)!.add(ida);
    }
    return map;
  }, [nodes, edges]);

  const lit = (id: string) =>
    !hover || id === hover || Boolean(neighbours.get(hover)?.has(id));

  const nodeShown = (node: GraphNode) => {
    if (!legendOn.size) return true;
    if (node.kind === "person") return legendOn.has("person");
    if (node.kind === "outside") {
      if (legendOn.has("outside")) return true;
      return Boolean(node.cap && legendOn.has(node.cap));
    }
    return Boolean(node.cap && legendOn.has(node.cap));
  };

  const toggleLegend = (key: string) => {
    setLegendOn((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toSvg = (e: React.PointerEvent) => {
    const svg = svgRef.current;
    const ctm = svg?.getScreenCTM();
    if (!svg || !ctm) return null;
    const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    return { x: pt.x, y: pt.y };
  };

  const activate = (node: GraphNode) => {
    if (node.kind === "person") {
      onPerson(node.id.slice(2), node.title.split(" · ")[0] || node.label);
    } else {
      onCompany(node.id.slice(2));
    }
  };

  return (
    <div className="fam-graph">
      <svg
        ref={svgRef}
        viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
        style={{ aspectRatio: `${view.w} / ${view.h}` }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          const p = toSvg(e);
          if (!p) return;
          drag.current.moved = true;
          const id = drag.current.id;
          setDragged((d) => ({ ...d, [id]: p }));
        }}
        onPointerUp={() => {
          justDragged.current = Boolean(drag.current?.moved);
          drag.current = null;
        }}
        onPointerLeave={() => {
          drag.current = null;
          setHover(null);
        }}
      >
        <g className="fam-edges">
          {edges.map(([a, b]) => {
            const na = nodes[a]!;
            const nb = nodes[b]!;
            const pa = pos(na);
            const pb = pos(nb);
            const on = hover != null && (na.id === hover || nb.id === hover);
            if (!nodeShown(na) || !nodeShown(nb)) return null;
            return (
              <line
                key={`${na.id}-${nb.id}`}
                x1={pa.x}
                y1={pa.y}
                x2={pb.x}
                y2={pb.y}
                className={on ? "on" : hover ? "dim" : ""}
              />
            );
          })}
        </g>
        {nodes.map((node) => {
          if (!nodeShown(node)) return null;
          const p = pos(node);
          return (
            <g
              key={node.id}
              className={`fam-node ${node.kind}${node.cap ? ` cap-${node.cap}` : ""}${lit(node.id) ? "" : " dim"}`}
              transform={`translate(${p.x} ${p.y})`}
              onPointerEnter={() => setHover(node.id)}
              onPointerLeave={() => setHover(null)}
              onPointerDown={() => {
                justDragged.current = false;
                drag.current = { id: node.id, moved: false };
              }}
              onClick={() => {
                if (justDragged.current) {
                  justDragged.current = false;
                  return;
                }
                activate(node);
              }}
            >
              <title>{node.title}</title>
              <circle r={node.r} />
              {node.kind === "person" ? (
                hover === node.id ? (
                  <text y={node.r + 11} className="fam-person-tip">
                    {node.title.split(" · ")[0]}
                  </text>
                ) : null
              ) : (
                <>
                  {chartUrl ? (
                    <a
                      href={chartUrl(node.id.slice(2))}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <text y={node.r + 10} className="fam-link">
                        {node.label}
                      </text>
                    </a>
                  ) : (
                    <text y={node.r + 10}>{node.label}</text>
                  )}
                  {node.kind === "outside" && hover === node.id ? (
                    <text y={node.r + 22} className="fam-mcap-tip">
                      {node.hint || "mcap —"}
                    </text>
                  ) : null}
                </>
              )}
            </g>
          );
        })}
      </svg>
      <div className="fam-legend">
        {CAP_LEGEND.map(([code, label]) => (
          <button
            key={code}
            type="button"
            className={`cap-${code}${legendOn.has(code) ? " is-on" : ""}`}
            aria-pressed={legendOn.has(code)}
            title={
              legendOn.has(code)
                ? `Show all nodes again (hide ${label})`
                : `Show only ${label} nodes`
            }
            onClick={() => toggleLegend(code)}
          >
            {label}
          </button>
        ))}
        <button
          type="button"
          className={`person${legendOn.has("person") ? " is-on" : ""}`}
          aria-pressed={legendOn.has("person")}
          title={
            legendOn.has("person")
              ? "Show all nodes again (hide people)"
              : "Show only people"
          }
          onClick={() => toggleLegend("person")}
        >
          Person
        </button>
        {outside.length ? (
          <button
            type="button"
            className={`outside${legendOn.has("outside") ? " is-on" : ""}`}
            aria-pressed={legendOn.has("outside")}
            title={
              legendOn.has("outside")
                ? "Show all nodes again (hide outside)"
                : "Show only outside-group companies"
            }
            onClick={() => toggleLegend("outside")}
          >
            Outside group
          </button>
        ) : null}
      </div>
    </div>
  );
}

type FamilyGraphProps = {
  companies: Company[];
  people: Person[];
  outside: Outside[];
  onCompany: (ticker: string) => void;
  onPerson: (personId: string, name: string) => void;
  chartUrl?: (ticker: string) => string;
};

/** Mount the SVG graph only when the card is near the viewport. */
export function LazyFamilyGraph(props: FamilyGraphProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [show, setShow] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) setShow(true);
      },
      { rootMargin: "160px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div ref={ref} className="fam-graph-lazy">
      {show ? <FamilyGraph {...props} /> : <div className="fam-graph-ph" aria-hidden />}
    </div>
  );
}
