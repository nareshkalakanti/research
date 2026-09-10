"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

export type TickerSuggestHit = {
  ticker: string;
  name: string;
  market: string;
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

export function TickerSuggest({
  value,
  onChange,
  onSelect,
  onSubmit,
  disabled,
  placeholder = "NSE ticker…",
  className = "buyback-url-input",
  style,
}: Props) {
  const listId = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [hits, setHits] = useState<TickerSuggestHit[]>([]);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const reqRef = useRef(0);

  const q = value.trim().toUpperCase();

  useEffect(() => {
    if (disabled || q.length < 1) {
      setHits([]);
      setOpen(false);
      return;
    }
    const id = ++reqRef.current;
    const t = window.setTimeout(() => {
      setLoading(true);
      void fetch(`/api/tickers?q=${encodeURIComponent(q)}&limit=12`, {
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
          setOpen(next.length > 0);
        })
        .catch(() => {
          if (id !== reqRef.current) return;
          setHits([]);
          setOpen(false);
        })
        .finally(() => {
          if (id === reqRef.current) setLoading(false);
        });
    }, 120);
    return () => window.clearTimeout(t);
  }, [q, disabled]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const pick = useCallback(
    (hit: TickerSuggestHit) => {
      onChange(hit.ticker);
      onSelect?.(hit);
      setOpen(false);
      setHits([]);
    },
    [onChange, onSelect],
  );

  const submitCurrent = useCallback(() => {
    if (open && hits[active]) {
      pick(hits[active]);
      return;
    }
    const t = value.trim().toUpperCase();
    if (t) onSubmit?.(t);
  }, [open, hits, active, pick, value, onSubmit]);

  return (
    <div className="ticker-suggest" ref={wrapRef} style={style}>
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
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={
          open && hits[active] ? `${listId}-${hits[active].ticker}` : undefined
        }
        onChange={(e) => {
          onChange(e.target.value.toUpperCase());
          setOpen(true);
        }}
        onFocus={() => {
          if (hits.length) setOpen(true);
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
      {open && hits.length > 0 ? (
        <ul id={listId} className="ticker-suggest-list" role="listbox">
          {hits.map((h, i) => (
            <li
              key={h.ticker}
              id={`${listId}-${h.ticker}`}
              role="option"
              aria-selected={i === active}
              className={`ticker-suggest-item${i === active ? " is-active" : ""}`}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(h);
              }}
            >
              <span className="ticker-suggest-sym">{h.ticker}</span>
              <span className="ticker-suggest-name">{h.name}</span>
              {h.market ? (
                <span className="ticker-suggest-mkt">{h.market}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {loading && q.length >= 1 && !hits.length ? (
        <div className="ticker-suggest-hint" aria-hidden>
          …
        </div>
      ) : null}
    </div>
  );
}
