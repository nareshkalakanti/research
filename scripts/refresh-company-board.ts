import fs from "node:fs";
import { runGovernanceRefreshBatch } from "../src/lib/governance-scan";
import { saveCompanyBoard, type BoardSeat } from "../src/lib/governance-write";

type BoardPayload = {
  ticker: string;
  name: string;
  market?: string;
  as_of?: string | null;
  source?: string;
  notes?: string | null;
  replaceSeats?: boolean;
  protectDinBoard?: boolean;
  seats: BoardSeat[];
};

function usage(): never {
  throw new Error(
    [
      "Usage:",
      "  npm run refresh:board -- APOLSINHOT",
      "  npm run refresh:board -- --tickers APOLSINHOT,TCS",
      "  npm run refresh:board -- --input board.json",
      "",
      "Automatic mode fetches the current board from NSE and replaces the ticker's seats.",
      "JSON mode is still available for pasted payloads.",
    ].join("\n"),
  );
}

function takeFlag(args: string[], name: string): string | null {
  const idx = args.findIndex((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
  if (idx === -1) return null;
  const hit = args[idx]!;
  args.splice(idx, 1);
  if (hit.includes("=")) return hit.split("=", 2)[1] ?? "";
  const next = args[idx];
  if (next == null || next.startsWith("--")) {
    throw new Error(`Missing value for --${name}`);
  }
  args.splice(idx, 1);
  return next;
}

function takeBoolFlag(args: string[], name: string): boolean | null {
  const on = args.indexOf(`--${name}`);
  if (on !== -1) {
    args.splice(on, 1);
    return true;
  }
  const off = args.indexOf(`--no-${name}`);
  if (off !== -1) {
    args.splice(off, 1);
    return false;
  }
  return null;
}

function takeCommaList(args: string[], name: string): string[] | null {
  const raw = takeFlag(args, name);
  if (raw == null) return null;
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function readJsonPayload(inputPath: string | null): BoardPayload {
  const raw = inputPath
    ? fs.readFileSync(inputPath, "utf8")
    : !process.stdin.isTTY
      ? fs.readFileSync(0, "utf8")
      : (() => usage())();
  const parsed = JSON.parse(raw) as Partial<BoardPayload>;
  if (!parsed || typeof parsed !== "object") usage();
  if (!Array.isArray(parsed.seats)) {
    throw new Error("Payload must include a seats array");
  }
  return parsed as BoardPayload;
}

function main() {
  const args = process.argv.slice(2);
  const inputPath = takeFlag(args, "input");
  const cliTickers = takeCommaList(args, "tickers") ?? [];
  const singleTicker = takeFlag(args, "ticker");
  if (singleTicker) cliTickers.push(singleTicker);
  const positionalTickers = args.filter((arg) => !arg.startsWith("--"));
  const tickers = [
    ...new Set(
      [...cliTickers, ...positionalTickers].map((t) => t.toUpperCase()).filter(Boolean),
    ),
  ];

  if (!inputPath && tickers.length) {
    void (async () => {
      const result = await runGovernanceRefreshBatch({
        tickers,
        limit: tickers.length,
      });
      console.log(
        `Refreshed ${result.saved_tickers.join(", ") || tickers.join(", ")}`
      );
      console.log(
        `saved=${result.saved} skipped=${result.skipped_empty + result.skipped_protected} failed=${result.failed} seats=${result.new_seats} events=${result.seat_events}`
      );
    })().catch((err) => {
      console.error(err);
      process.exit(1);
    });
    return;
  }

  if (!inputPath) usage();
  const payload = readJsonPayload(inputPath);

  const ticker = payload.ticker;
  const name = takeFlag(args, "name") || payload.name;
  const market = takeFlag(args, "market") || payload.market || "NSE";
  const asOf = takeFlag(args, "as-of") || payload.as_of || undefined;
  const source = takeFlag(args, "source") || payload.source || "nse_integrated_governance";
  const notes = takeFlag(args, "notes") || payload.notes || undefined;

  const replaceSeats = takeBoolFlag(args, "replace-seats");
  const protectDinBoard = takeBoolFlag(args, "protect-din-board");

  if (args.length) {
    throw new Error(`Unknown arguments: ${args.join(" ")}`);
  }

  if (!ticker || !name) usage();

  const result = saveCompanyBoard({
    ticker,
    name,
    market,
    as_of: asOf ?? null,
    source,
    notes: notes ?? null,
    replaceSeats: replaceSeats ?? true,
    protectDinBoard: protectDinBoard ?? true,
    seats: payload.seats,
  });

  if (result.skipped) {
    console.log(`Skipped ${ticker}: ${result.reason}`);
    return;
  }

  console.log(`Updated ${ticker}: ${result.seats} seats${result.events_recorded ? `, ${result.events_recorded} events` : ""}`);
}

main();
