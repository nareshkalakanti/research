"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useAppTab } from "@/lib/app-tab";

export type TickerSuggestHit = {
  ticker: string;
  name: string;
  market: string;
  sector?: string | null;
  mcap_cr?: number | null;
};

type Props = {
  value: string;
  onChange: (ticker: string) => void;
  /** Called when user picks a suggestion (includes company name). */
  onSelect?: (hit: TickerSuggestHit) => void;
  /** Called when user picks a suggestion or presses Enter with a value. */
  onSubmit?: (ticker: string) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  style?: React.CSSProperties;
};

type PanelPos = { top: number; left: number; width: number };

function fmtMcap(cr: number | null | undefined): string | null {
  if (cr == null || !Number.isFinite(cr)) return null;
  if (cr >= 10_000) return `₹${(cr / 1000).toFixed(1)}k Cr`;
  if (cr >= 100) return `₹${Math.round(cr).toLocaleString("en-IN")} Cr`;
  if (cr >= 10) return `₹${cr.toFixed(0)} Cr`;
  return `₹${cr.toFixed(1)} Cr`;
}

function marketKind(market: string): "nse" | "bse" | "sme" | "other" {
  const m = market.toUpperCase();
  if (m.includes("SME") || m.includes("EMERGE")) return "sme";
  if (m.startsWith("BSE")) return "bse";
  if (m.startsWith("NSE") || m === "") return "nse";
  return "other";
}

function marketLabel(market: string): string {
  const kind = marketKind(market);
  if (kind === "sme") return "SME";
  if (kind === "bse") return "BSE";
  if (kind === "nse") return "NSE";
  return market || "—";
}

function highlightMatch(text: string, q: string): ReactNode {
  if (!q || !text) return text;
  const i = text.toUpperCase().indexOf(q.toUpperCase());
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <mark className="ticker-suggest-mark">{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

export function TickerSuggest({
  value,
  onChange,
  onSelect,
  onSubmit,
  disabled,
  placeholder = "Search ticker or company…",
  className = "buyback-url-input",
  style,
}: Props) {
  const listId = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const [hits, setHits] = useState<TickerSuggestHit[]>([]);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [pos, setPos] = useState<PanelPos | null>(null);
  const [mounted, setMounted] = useState(false);
  const reqRef = useRef(0);
  const pickedRef = useRef<string | null>(null);
  const { tab } = useAppTab();

  const q = value.trim().toUpperCase();
  const showPanel = open && q.length >= 1 && (loading || searched);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    setOpen(false);
    setHits([]);
    setSearched(false);
    setLoading(false);
  }, [tab]);

  const updatePos = useCallback(() => {
    const el = fieldRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const width = Math.min(Math.max(r.width, 320), 440);
    let left = r.left;
    if (left + width > window.innerWidth - 12) {
      left = Math.max(12, window.innerWidth - width - 12);
    }
    const below = r.bottom + 6;
    const maxH = 360;
    const spaceBelow = window.innerHeight - below - 12;
    const top =
      spaceBelow < 160 && r.top > spaceBelow
        ? Math.max(12, r.top - Math.min(maxH, r.top - 12) - 6)
        : below;
    setPos({ top, left, width });
  }, []);

  useLayoutEffect(() => {
    if (!showPanel) {
      setPos(null);
      return;
    }
    updatePos();
  }, [showPanel, hits.length, updatePos]);

  useEffect(() => {
    if (!showPanel) return;
    const onWin = () => updatePos();
    window.addEventListener("resize", onWin);
    window.addEventListener("scroll", onWin, true);
    return () => {
      window.removeEventListener("resize", onWin);
      window.removeEventListener("scroll", onWin, true);
    };
  }, [showPanel, updatePos]);

  useEffect(() => {
    if (disabled || q.length < 1) {
      setHits([]);
      setOpen(false);
      setSearched(false);
      setLoading(false);
      return;
    }
    if (pickedRef.current && q === pickedRef.current) {
      pickedRef.current = null;
      setHits([]);
      setOpen(false);
      setSearched(false);
      setLoading(false);
      return;
    }
    const id = ++reqRef.current;
    const t = window.setTimeout(() => {
      setLoading(true);
      void fetch(`/api/tickers?q=${encodeURIComponent(q)}&limit=14`, {
        signal: AbortSignal.timeout(8_000),
      })
        .then(async (res) => {
          const json = (await res.json()) as {
            ok?: boolean;
            hits?: TickerSuggestHit[];
          };
          if (id !== reqRef.current) return;
          const next = Array.isArray(json.hits) ? json.hits : [];
          setHits(next);
          setActive(0);
          setSearched(true);
          setOpen(true);
        })
        .catch(() => {
          if (id !== reqRef.current) return;
          setHits([]);
          setSearched(true);
          setOpen(true);
        })
        .finally(() => {
          if (id === reqRef.current) setLoading(false);
        });
    }, 100);
    return () => window.clearTimeout(t);
  }, [q, disabled]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (wrapRef.current?.contains(t)) return;
      if ((t as Element).closest?.(".ticker-suggest-portal")) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  useEffect(() => {
    if (!open || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(
      `[data-idx="${active}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [active, open, hits]);

  const pick = useCallback(
    (hit: TickerSuggestHit) => {
      const t = hit.ticker.trim().toUpperCase();
      pickedRef.current = t;
      reqRef.current += 1;
      onChange(t);
      onSelect?.(hit);
      setOpen(false);
      setHits([]);
      setSearched(false);
      setLoading(false);
    },
    [onChange, onSelect],
  );

  const submitCurrent = useCallback(() => {
    if (open && hits[active]) {
      pick(hits[active]!);
      return;
    }
    const t = value.trim().toUpperCase();
    if (t) onSubmit?.(t);
  }, [open, hits, active, pick, value, onSubmit]);

  const panel =
    mounted && showPanel && pos
      ? createPortal(
          <div
            className="ticker-suggest-portal"
            style={{
              top: pos.top,
              left: pos.left,
              width: pos.width,
            }}
          >
            <div className="ticker-suggest-panel" role="presentation">
              {hits.length > 0 ? (
                <ul
                  id={listId}
                  ref={listRef}
                  className="ticker-suggest-list"
                  role="listbox"
                >
                  {hits.map((h, i) => {
                    const mcap = fmtMcap(h.mcap_cr);
                    const kind = marketKind(h.market);
                    return (
                      <li
                        key={`${h.ticker}-${h.market}`}
                        id={`${listId}-${h.ticker}`}
                        data-idx={i}
                        role="option"
                        aria-selected={i === active}
                        className={`ticker-suggest-item${i === active ? " is-active" : ""}`}
                        onMouseEnter={() => setActive(i)}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          pick(h);
                        }}
                      >
                        <div className="ticker-suggest-main">
                          <div className="ticker-suggest-top">
                            <span className="ticker-suggest-sym">
                              {highlightMatch(h.ticker, q)}
                            </span>
                            <span
                              className={`ticker-suggest-mkt ticker-suggest-mkt--${kind}`}
                            >
                              {marketLabel(h.market)}
                            </span>
                          </div>
                          <div className="ticker-suggest-name">
                            {highlightMatch(h.name, q)}
                          </div>
                          {h.sector || mcap ? (
                            <div className="ticker-suggest-meta">
                              {h.sector ? <span>{h.sector}</span> : null}
                              {h.sector && mcap ? (
                                <span className="ticker-suggest-dot" aria-hidden>
                                  ·
                                </span>
                              ) : null}
                              {mcap ? <span>{mcap}</span> : null}
                            </div>
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              ) : loading ? (
                <div className="ticker-suggest-empty">Searching…</div>
              ) : (
                <div className="ticker-suggest-empty">
                  No matches for <strong>{q}</strong>
                </div>
              )}
              {hits.length > 0 ? (
                <div className="ticker-suggest-foot" aria-hidden>
                  <span>
                    <kbd>↑</kbd>
                    <kbd>↓</kbd> move
                  </span>
                  <span>
                    <kbd>↵</kbd> add
                  </span>
                  <span>
                    <kbd>esc</kbd> close
                  </span>
                </div>
              ) : null}
            </div>
          </div>,
          document.body,
        )
      : null;

  return (
    <div
      className={`ticker-suggest${showPanel ? " is-open" : ""}${loading ? " is-loading" : ""}`}
      ref={wrapRef}
      style={style}
    >
      <div className="ticker-suggest-field" ref={fieldRef}>
        <span className="ticker-suggest-icon" aria-hidden>
          ⌕
        </span>
        <input
          type="text"
          className={className}
          placeholder={placeholder}
          value={value}
          disabled={disabled}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          role="combobox"
          aria-expanded={showPanel}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={
            showPanel && hits[active]
              ? `${listId}-${hits[active].ticker}`
              : undefined
          }
          onChange={(e) => {
            onChange(e.target.value.toUpperCase());
            setOpen(true);
          }}
          onFocus={() => {
            if (q.length >= 1) setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              if (!hits.length) return;
              setOpen(true);
              setActive((i) => (i + 1) % hits.length);
              return;
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              if (!hits.length) return;
              setOpen(true);
              setActive((i) => (i - 1 + hits.length) % hits.length);
              return;
            }
            if (e.key === "Escape") {
              e.preventDefault();
              setOpen(false);
              return;
            }
            if (e.key === "Enter") {
              e.preventDefault();
              submitCurrent();
            }
          }}
        />
        {loading ? (
          <span className="ticker-suggest-spinner" aria-hidden />
        ) : value ? (
          <button
            type="button"
            className="ticker-suggest-clear"
            tabIndex={-1}
            aria-label="Clear"
            disabled={disabled}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              onChange("");
              setHits([]);
              setOpen(false);
              setSearched(false);
            }}
          >
            ×
          </button>
        ) : null}
      </div>
      {panel}
    </div>
  );
}
