"use client";

import { useCallback, useEffect, useState } from "react";

type Preview = {
  linked: number;
  skipped_none: number;
  skipped_ambiguous: number;
  skipped_weak: number;
  message?: string;
};

type Props = {
  onDone?: () => void | Promise<void>;
};

export function MapGrowwDinButton({ onDone }: Props) {
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [detail, setDetail] = useState<string | null>(null);

  const loadPreview = useCallback(async () => {
    try {
      const res = await fetch("/api/governance-groww-map");
      if (!res.ok) return;
      const json = (await res.json()) as Preview;
      setPreview(json);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void loadPreview();
  }, [loadPreview]);

  const run = useCallback(async () => {
    setBusy(true);
    setDetail("Matching unique Groww names to DIN directors…");
    try {
      const res = await fetch("/api/governance-groww-map", { method: "POST" });
      const json = (await res.json()) as Preview & { ok?: boolean };
      if (!res.ok || json.ok === false) {
        throw new Error(json.message || "Map failed");
      }
      setDetail(
        json.message ||
          `Linked ${json.linked} · skipped ${json.skipped_ambiguous} ambiguous · ${json.skipped_weak} common names`,
      );
      await loadPreview();
      await onDone?.();
    } catch (err) {
      setDetail(err instanceof Error ? err.message : "Map failed");
    } finally {
      setBusy(false);
    }
  }, [loadPreview, onDone]);

  const n = preview?.linked ?? 0;

  return (
    <div className="scan-block gov-scan">
      <div className="chip-row">
        <span className="chip-label">Groww names</span>
        <button
          type="button"
          className="btn-scan"
          disabled={busy || n === 0}
          onClick={() => void run()}
          title="Link unique Groww CEO/MD names to existing DIN directors. Common names are not merged."
        >
          {busy ? "Mapping…" : "Map to DIN"}
          {n > 0 ? <span className="chip-count">{n}</span> : null}
        </button>
      </div>
      {detail ? <p className="hint tight missing-export-hint">{detail}</p> : null}
    </div>
  );
}
