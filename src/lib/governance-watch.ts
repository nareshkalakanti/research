import fs from "fs";
import path from "path";

export type GovWatchEntry = {
  person_id: string;
  din: string | null;
  name: string;
  note?: string;
};

const WATCH_PATH = path.join(process.cwd(), "data", "gov_watch.json");

let cache: { at: number; pinned: GovWatchEntry[]; ids: Set<string> } | null =
  null;

export function loadGovWatch(): GovWatchEntry[] {
  const now = Date.now();
  if (cache && now - cache.at < 60_000) return cache.pinned;
  if (!fs.existsSync(WATCH_PATH)) {
    cache = { at: now, pinned: [], ids: new Set() };
    return [];
  }
  const raw = JSON.parse(fs.readFileSync(WATCH_PATH, "utf8")) as {
    pinned?: GovWatchEntry[];
  };
  const pinned = Array.isArray(raw.pinned) ? raw.pinned : [];
  const ids = new Set(
    pinned
      .flatMap((p) => [p.person_id, p.din].filter(Boolean))
      .map((s) => String(s).trim()),
  );
  cache = { at: now, pinned, ids };
  return pinned;
}

export function isWatchedPerson(personId: string, din?: string | null): boolean {
  const ids = new Set(
    loadGovWatch()
      .flatMap((p) => [p.person_id, p.din].filter(Boolean))
      .map((s) => String(s).trim()),
  );
  if (ids.has(personId.trim())) return true;
  const d = din?.trim();
  return Boolean(d && ids.has(d));
}
