"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { TickerSuggest, type TickerSuggestHit } from "@/components/TickerSuggest";

type Row = { id: string; label: string; n: number; starred?: boolean };
type Member = { ticker: string; name: string; market: string };

type ShotEvent = {
  t: string;
  industry?: string;
  names?: string[];
  query?: string;
  ticker?: string;
  n?: number;
  label?: string;
  error?: string;
  extracted?: number;
  resolved?: number;
  unresolved?: number | string[];
  before?: number;
  after?: number;
  sector?: { id: string; label: string; members?: unknown[] };
};

export function SectorShotPanel() {
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);
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
  const lastIndustry = useRef("");
  const [newName, setNewName] = useState("");
  const [newTickers, setNewTickers] = useState<TickerSuggestHit[]>([]);
  const [newQ, setNewQ] = useState("");
  const [addQ, setAddQ] = useState("");
  const [creating, setCreating] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [members, setMembers] = useState<Member[]>([]);

  const loadList = useCallback(async () => {
    try {
      const res = await fetch("/api/sector-rotation?summary=1", {
        cache: "no-store",
      });
      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        sectors?: Row[];
      };
      if (!res.ok || json.ok === false) {
        throw new Error(json.error || `HTTP ${res.status}`);
      }
      setRows(json.sectors ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  const loadMembers = useCallback(async (id: string) => {
    const res = await fetch(
      `/api/sector-rotation?id=${encodeURIComponent(id)}&members=1`,
      { cache: "no-store" },
    );
    const json = (await res.json()) as {
      ok?: boolean;
      sector?: { members?: Member[] };
    };
    setMembers(json.sector?.members ?? []);
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setMembers([]);
      return;
    }
    void loadMembers(selectedId);
  }, [selectedId, loadMembers]);

  const runScreenshot = useCallback(
    async (file: File, priorIndustry = "") => {
      if (file.type && !file.type.startsWith("image/") && file.type) return "";
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
        let donePayload: ShotEvent | null = null;
        let streamError = "";
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() || "";
          for (const line of lines) {
            if (!line.trim()) continue;
            let ev: ShotEvent;
            try {
              ev = JSON.parse(line) as ShotEvent;
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
            } else if (ev.t === "parsed") {
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
              pushLog(
                `Count: OCR ${ev.extracted ?? 0} · matched ${ev.resolved ?? 0} · basket ${ev.before ?? 0} → ${ev.after ?? 0}`,
              );
            } else if (ev.t === "save") {
              pushLog(`Saved ${ev.n} stocks in “${ev.label}”`);
            } else if (ev.t === "done") {
              donePayload = ev;
            } else if (ev.t === "error") {
              streamError = ev.error || "Extract failed";
              pushLog(streamError);
            }
          }
        }
        if (streamError) throw new Error(streamError);
        if (!donePayload?.sector?.id) {
          throw new Error("Screenshot import did not finish");
        }
        const saved = donePayload.sector;
        const n = Array.isArray(saved.members) ? saved.members.length : donePayload.after ?? 0;
        setRows((prev) => {
          const row = {
            id: saved.id,
            label: saved.label,
            n,
            starred: false,
          };
          const i = prev.findIndex((r) => r.id === saved.id);
          if (i >= 0) {
            const next = [...prev];
            next[i] = row;
            return next;
          }
          return [...prev, row];
        });
        setSelectedId(saved.id);
        await loadList();
        pushLog("List refreshed");
        return donePayload.industry || saved.label || "";
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        setShotLog((prev) => [...prev, `Failed: ${msg}`]);
        return "";
      }
    },
    [loadList],
  );

  const enqueueShot = useCallback(
    (file: File) => {
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
            const industry = await runScreenshot(
              next,
              lastIndustry.current,
            );
            if (industry) lastIndustry.current = industry;
          }
        } finally {
          shotRunning.current = false;
          setShotBusy(false);
          setShotQueued(0);
        }
      })();
    },
    [runScreenshot],
  );
  fromShotRef.current = enqueueShot;

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

  const takeFiles = (list: FileList | File[] | null) => {
    const files = [...(list ?? [])];
    for (const f of files) enqueueShot(f);
  };

  const selected = rows.find((r) => r.id === selectedId) ?? null;

  const createSector = async () => {
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
        sector?: { id: string; label: string };
      };
      if (!res.ok || !json.sector?.id) {
        throw new Error(json.error || `HTTP ${res.status}`);
      }
      const id = json.sector.id;
      for (const h of newTickers) {
        await fetch("/api/sector-rotation", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id,
            add: true,
            ticker: h.ticker,
            name: h.name,
            market: h.market || "NSE",
          }),
        });
      }
      setNewName("");
      setNewTickers([]);
      setNewQ("");
      setSelectedId(id);
      await loadList();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  const addToSelected = async (h: TickerSuggestHit) => {
    if (!selectedId) return;
    setError(null);
    setAddQ("");
    const res = await fetch("/api/sector-rotation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: selectedId,
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
    await loadList();
    await loadMembers(selectedId);
  };

  const removeFromSelected = async (ticker: string) => {
    if (!selectedId) return;
    setError(null);
    const res = await fetch("/api/sector-rotation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: selectedId, remove: true, ticker }),
    });
    const json = (await res.json()) as { ok?: boolean; error?: string };
    if (!res.ok || json.ok === false) {
      setError(json.error || `HTTP ${res.status}`);
      return;
    }
    await loadList();
    await loadMembers(selectedId);
  };

  return (
    <div className="rot-shot-simple">
      <div className="rot-shot-simple-main">
      <p className="rot-shot-simple-lead">
        Paste or drop a screener screenshot. Same industry merges.{" "}
        <strong>{rows.length}</strong> sectors saved.
      </p>
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
            enqueueShot(file);
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
          takeFiles(e.dataTransfer.files);
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
                  takeFiles(e.target.files);
                  e.target.value = "";
                }}
              />
            </label>
          </>
        ) : (
          <div className="din-paste-hint">
            <strong>Paste or choose screenshots</strong>
            <span>Industry column becomes the sector name.</span>
            <label className="din-paste-upload">
              Choose images
              <input
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(e) => {
                  takeFiles(e.target.files);
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
      <table className="rot-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Sector</th>
            <th>Stocks</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <Fragment key={r.id}>
            <tr
              className={r.id === selectedId ? "rot-row is-on" : "rot-row"}
              onClick={() =>
                setSelectedId((cur) => (cur === r.id ? null : r.id))
              }
            >
              <td>{i + 1}</td>
              <td>{r.label}</td>
              <td>{r.n}</td>
            </tr>
            {r.id === selectedId ? (
              <tr className="rot-shot-open">
                <td colSpan={3}>
                  <div className="rot-shot-open-inner">
                    <TickerSuggest
                      value={addQ}
                      onChange={setAddQ}
                      onSelect={(h) => void addToSelected(h)}
                      clearOnSelect
                      persistGroww={false}
                      placeholder="Add company…"
                      className="fam-dash-search"
                      submitLabel="add"
                    />
                    {members.length ? (
                      <table className="rot-table rot-shot-members rot-table--members">
                        <thead>
                          <tr>
                            <th className="rot-col-num">#</th>
                            <th className="rot-col-stock">Stock</th>
                            <th className="rot-col-sym">Symbol</th>
                            <th className="rot-col-act" />
                          </tr>
                        </thead>
                        <tbody>
                          {members.map((m, mi) => (
                            <tr key={m.ticker}>
                              <td>{mi + 1}</td>
                              <td>{m.name}</td>
                              <td className="mono">{m.ticker}</td>
                              <td>
                                <button
                                  type="button"
                                  className="btn-ghost"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    void removeFromSelected(m.ticker);
                                  }}
                                >
                                  Remove
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      <p className="rot-create-pick">No stocks yet.</p>
                    )}
                  </div>
                </td>
              </tr>
            ) : null}
            </Fragment>
          ))}
        </tbody>
      </table>
      </div>
      <aside className="rot-shot-simple-side">
        <form
          className="fam-dash-create"
          onSubmit={(e) => {
            e.preventDefault();
            void createSector();
          }}
        >
          <input
            className="fam-dash-search"
            placeholder="Sector name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            aria-label="New sector name"
          />
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
              onSelect={(h) => {
                setNewTickers((rows) =>
                  rows.some((x) => x.ticker === h.ticker) ? rows : [...rows, h],
                );
                setNewQ("");
              }}
              clearOnSelect
              persistGroww={false}
              placeholder="Add company…"
              className="fam-dash-search"
              submitLabel="add"
            />
          </div>
          <button
            type="submit"
            className="btn-ghost"
            disabled={creating || newName.trim().length < 2}
          >
            {creating ? "Saving…" : "Create sector"}
          </button>
        </form>
        <div className="fam-dash-create" style={{ marginTop: 10 }}>
          <p className="rot-create-pick">
            {selected
              ? `Add stock to ${selected.label}`
              : "Select a sector in the list, then add a stock"}
          </p>
          <TickerSuggest
            value={addQ}
            onChange={setAddQ}
            onSelect={(h) => void addToSelected(h)}
            clearOnSelect
            persistGroww={false}
            disabled={!selectedId}
            placeholder="Add company…"
            className="fam-dash-search"
            submitLabel="add"
          />
        </div>
      </aside>
    </div>
  );
}
