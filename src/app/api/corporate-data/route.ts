import { NextRequest, NextResponse } from "next/server";
import {
  findCorporateBoardDocument,
  isNseTransportFailure,
  markNseBlocked,
  clearNseCircuit,
  NseAnnouncementsBlockedError,
} from "@/lib/corporate-data-announcements";
import { extractCorporateFromPdfUrl } from "@/lib/corporate-data-extract";
import {
  CORPORATE_DATA_SEED,
  corporateListCounts,
  emptyExtract,
  enrichExtractWithExpected,
  expectedFromGovernance,
  listCorporateDataRows,
  pushExtractToGovernance,
  pushListExtractsToGovernance,
  saveCorporateExtract,
  upsertCorporateConcall,
  upsertCorporateDocument,
  type CorporateExtractPayload,
  type CorporateListFilter,
} from "@/lib/corporate-data";
import {
  extractCorporateConcall,
  mergeConcallIntoExtract,
} from "@/lib/corporate-concall-extract";
import { loadHoldings } from "@/lib/holdings";
import { findLatestTrendlyneConcall } from "@/lib/trendlyne-investor-discover";

export const runtime = "nodejs";
export const maxDuration = 300;

async function scanConcall(ticker: string, market: string) {
  const empty = {
    found: false as const,
    concall_url: null as string | null,
    concall_title: null as string | null,
    concall_period: null as string | null,
    concall_date: null as string | null,
    hit: null as Awaited<ReturnType<typeof findLatestTrendlyneConcall>>,
  };
  try {
    const hit = await findLatestTrendlyneConcall(ticker);
    if (hit) {
      upsertCorporateConcall({
        ticker,
        market,
        concall_url: hit.url,
        concall_title: hit.title,
        concall_period: hit.period,
        concall_date: hit.date_label,
      });
      return {
        found: true as const,
        concall_url: hit.url,
        concall_title: hit.title,
        concall_period: hit.period,
        concall_date: hit.date_label,
        hit,
      };
    }
  } catch {
    /* fall through to stored materials */
  }

  // Prefer local transcript metadata when Trendlyne has nothing —
  // still pick current-year / latest period, not longest text.
  try {
    const { listInvestorMaterials } = await import("@/lib/investor-materials");
    const preferYear = new Date().getFullYear();
    const storedAll = listInvestorMaterials(ticker).filter(
      (m) =>
        (m.kind === "concall" || m.kind === "transcript") &&
        ((m.raw_text || "").trim().length > 400 ||
          (m.brief_text || "").trim().length > 200),
    );
    const yearOf = (period: string | null | undefined) => {
      const m = (period || "").match(/(\d{4})/);
      return m ? Number(m[1]) : 0;
    };
    const periodKey = (period: string | null | undefined) => {
      const m = (period || "").trim().match(/^([A-Za-z]{3})\s+(\d{4})$/);
      if (!m) return yearOf(period) * 12;
      const months: Record<string, number> = {
        jan: 1,
        feb: 2,
        mar: 3,
        apr: 4,
        may: 5,
        jun: 6,
        jul: 7,
        aug: 8,
        sep: 9,
        oct: 10,
        nov: 11,
        dec: 12,
      };
      return Number(m[2]) * 12 + (months[m[1]!.toLowerCase()] ?? 0);
    };
    const currentYear = storedAll.filter((m) => yearOf(m.period) === preferYear);
    const pool = currentYear.length ? currentYear : storedAll;
    const stored = [...pool].sort((a, b) => {
      const pd = periodKey(b.period) - periodKey(a.period);
      if (pd) return pd;
      return (b.raw_text?.length || 0) - (a.raw_text?.length || 0);
    })[0];
    if (stored) {
      upsertCorporateConcall({
        ticker,
        market,
        concall_url: stored.source_url,
        concall_title: stored.title,
        concall_period: stored.period,
        concall_date: null,
      });
      return {
        found: true as const,
        concall_url: stored.source_url,
        concall_title: stored.title,
        concall_period: stored.period,
        concall_date: null as string | null,
        hit: null,
      };
    }
  } catch {
    /* ignore */
  }
  return empty;
}

async function scanDocument(ticker: string, market: string) {
  try {
    const doc = await findCorporateBoardDocument(ticker, market);
    if (!doc) {
      upsertCorporateDocument({
        ticker,
        market,
        document_url: null,
        document_title: null,
      });
      return {
        found: false as const,
        blocked: false as const,
        document_url: null as string | null,
        document_title: null as string | null,
        date: null as string | null,
        error: "No board/director announcement PDF in last 3y",
      };
    }
    upsertCorporateDocument({
      ticker,
      market,
      document_url: doc.url,
      document_title: doc.title,
      document_date: doc.date,
    });
    return {
      found: true as const,
      blocked: false as const,
      document_url: doc.url,
      document_title: doc.title,
      date: doc.date,
      error: null as string | null,
    };
  } catch (e) {
    // Akamai / HTTP2 / 403 — soft fail, never 500
    if (isNseTransportFailure(e) || e instanceof NseAnnouncementsBlockedError) {
      const circuitSkip =
        e instanceof NseAnnouncementsBlockedError &&
        /circuit open/i.test(e.message);
      if (!circuitSkip) markNseBlocked();
      return {
        found: false as const,
        blocked: true as const,
        document_url: null as string | null,
        document_title: null as string | null,
        date: null as string | null,
        error:
          e instanceof Error
            ? e.message
            : "NSE blocked (Akamai) — Trendlyne concall / stored PDF only",
      };
    }
    return {
      found: false as const,
      blocked: true as const,
      document_url: null as string | null,
      document_title: null as string | null,
      date: null as string | null,
      error: e instanceof Error ? e.message : "NSE scan failed",
    };
  }
}

async function extractDocument(
  ticker: string,
  market: string,
  docUrl: string | null,
  docTitle: string | null,
) {
  let url = docUrl;
  let title = docTitle;
  if (!url) {
    const scanned = await scanDocument(ticker, market);
    url = scanned.document_url;
    title = scanned.document_title;
    if (!url) {
      return {
        ok: false,
        engine: "none",
        status: "no_document",
        extracted: null,
        text_chars: 0,
        error: scanned.error || "No document",
        document_url: null as string | null,
        document_title: null as string | null,
      };
    }
  }

  const result = await extractCorporateFromPdfUrl(url);
  const expected = expectedFromGovernance(ticker);
  const enriched = enrichExtractWithExpected(result.extracted, expected);
  const extracted = enriched.extracted;
  const engine =
    enriched.filled > 0
      ? `${result.engine}+expected-din`
      : result.engine;
  const status =
    enriched.filled > 0 &&
    (result.status === "empty_extract" || result.status === "ok")
      ? "ok"
      : result.status;
  const extractOk =
    result.ok ||
    extracted.directors.some((d) => !!d.din) ||
    extracted.kmp.some((k) => !!k.din);

  saveCorporateExtract({
    ticker,
    market,
    extracted,
    engine,
    status,
    document_url: url,
    document_title: title,
  });

  const gov_push =
    extractOk &&
    extracted.directors.some((d) => !!d.din)
      ? pushExtractToGovernance({
          ticker,
          market,
          extracted,
        })
      : null;

  return {
    ok: true, // pipeline finished; check status/extracted for content
    extract_ok: extractOk,
    engine,
    status,
    extracted,
    text_chars: result.text_chars,
    error: result.error ?? null,
    document_url: url,
    document_title: title,
    expected_din_filled: enriched.filled,
    gov_push,
  };
}

async function attachConcallExtract(
  ticker: string,
  market: string,
  boardExtract: CorporateExtractPayload | null,
  boardEngine: string | null,
  boardStatus: string | null,
  concallHit: Awaited<ReturnType<typeof findLatestTrendlyneConcall>>,
  documentUrl: string | null,
  documentTitle: string | null,
): Promise<{
  extracted: CorporateExtractPayload;
  engine: string;
  status: string;
  extract_ok: boolean;
}> {
  const base = boardExtract ? { ...boardExtract } : emptyExtract(documentUrl);
  const concallPayload = await extractCorporateConcall(ticker, concallHit);
  const extracted = mergeConcallIntoExtract(base, concallPayload);
  const hasBoard =
    extracted.directors.length > 0 || extracted.kmp.length > 0;
  const hasConcall = !!(
    extracted.concall?.summary ||
    extracted.concall?.guidance ||
    extracted.concall?.margins ||
    extracted.concall?.capex ||
    extracted.concall?.sentiment ||
    extracted.concall?.url
  );
  const engineParts = [
    boardEngine && hasBoard ? boardEngine : null,
    hasConcall
      ? extracted.concall?.source === "investor_materials"
        ? "stored-concall"
        : "trendlyne-concall"
      : null,
  ].filter(Boolean);
  const engine = engineParts.join("+") || boardEngine || "none";
  const status =
    hasBoard || hasConcall
      ? boardStatus === "ok" || hasConcall
        ? "ok"
        : boardStatus || "ok"
      : boardStatus || "empty_extract";
  const extract_ok = hasBoard || hasConcall;

  saveCorporateExtract({
    ticker,
    market,
    extracted,
    engine,
    status,
    document_url: documentUrl,
    document_title: documentTitle,
  });

  if (concallPayload?.url || concallPayload?.period) {
    upsertCorporateConcall({
      ticker,
      market,
      concall_url: concallPayload.url,
      concall_title: concallPayload.title,
      concall_period: concallPayload.period,
    });
  }

  return { extracted, engine, status, extract_ok };
}

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("market") || "All";
  const market = (
    raw === "NSE" ||
    raw === "NSE SME" ||
    raw === "Holdings" ||
    raw === "Gov board" ||
    raw === "All"
      ? raw
      : "All"
  ) as CorporateListFilter;
  const forceNse = req.nextUrl.searchParams.get("nse") === "1";
  const rows = listCorporateDataRows(market);

  const dinMissing = rows
    .filter((r) => {
      const flags = r.gap.flags;
      // din_off_board = extracted DIN(s) but not on Expected — still a usable extract
      if (flags.includes("din_off_board") && !flags.includes("names_no_din")) {
        return false;
      }
      if (flags.includes("din_ok") && !flags.includes("names_no_din")) {
        return false;
      }
      return (
        flags.includes("empty") ||
        flags.includes("wrong_doc") ||
        flags.includes("names_no_din") ||
        flags.includes("kmp_only") ||
        (r.gap.match_din === 0 &&
          !(r.extracted?.directors || []).some((d) => d.din))
      );
    })
    .map((r) => ({
      ticker: r.ticker,
      name: r.name,
      missing_din: r.gap.missing_din,
      names_no_din: r.gap.names_no_din,
      match_din: r.gap.match_din,
      flags: r.gap.flags,
      summary: r.gap.summary,
    }));

  const dinOffBoard = rows
    .filter((r) => r.gap.flags.includes("din_off_board"))
    .map((r) => r.ticker);

  let nse_feed = null;
  try {
    const { checkNseFeedStatus } = await import("@/lib/nse-feed-status");
    const { nseCircuitRemainingMs, isNseCircuitOpen } = await import(
      "@/lib/corporate-data-announcements"
    );
    const status = await checkNseFeedStatus({ force: forceNse });
    nse_feed = {
      ...status,
      circuit_open: isNseCircuitOpen(),
      circuit_remaining_ms: nseCircuitRemainingMs(),
    };
  } catch {
    nse_feed = null;
  }

  return NextResponse.json({
    ok: true,
    market,
    seed: CORPORATE_DATA_SEED.length,
    counts: corporateListCounts(),
    rows,
    din_missing: {
      count: dinMissing.length,
      tickers: dinMissing.map((d) => d.ticker),
      rows: dinMissing,
    },
    din_off_board: {
      count: dinOffBoard.length,
      tickers: dinOffBoard,
    },
    nse_feed,
  });
}

export async function POST(req: NextRequest) {
  let ticker = "";
  try {
    const body = (await req.json()) as {
      action?:
        | "scan"
        | "extract"
        | "run"
        | "save"
        | "reset-nse"
        | "push-gov"
        | "push-gov-batch";
      ticker?: string;
      market?: string;
      extracted?: CorporateExtractPayload;
      /** Clear soft NSE circuit so this request tries NSE again */
      reset_nse?: boolean;
    };
    const action = body.action || "run";

    if (action === "reset-nse") {
      clearNseCircuit();
      return NextResponse.json({ ok: true, status: "nse_circuit_cleared" });
    }

    if (action === "push-gov-batch") {
      const raw = (body.market || "Gov board").trim();
      const market = (
        raw === "NSE" ||
        raw === "NSE SME" ||
        raw === "Holdings" ||
        raw === "Gov board" ||
        raw === "All"
          ? raw
          : "Gov board"
      ) as CorporateListFilter;
      const batch = pushListExtractsToGovernance(market);
      return NextResponse.json({
        ok: true,
        action: "push-gov-batch",
        market,
        attempted: batch.attempted,
        ok_count: batch.ok,
        failed: batch.failed,
        pushed_seats: batch.pushed_seats,
        results: batch.results,
      });
    }

    ticker = (body.ticker || "").trim().toUpperCase();
    if (!ticker) {
      return NextResponse.json(
        { ok: false, error: "ticker required" },
        { status: 400 },
      );
    }
    if (body.reset_nse) clearNseCircuit();
    const seed = CORPORATE_DATA_SEED.find((s) => s.ticker === ticker);
    const holding = loadHoldings().find((h) => h.ticker.toUpperCase() === ticker);
    const market = body.market || seed?.market || holding?.market || "NSE";

    if (action === "push-gov") {
      const stored =
        listCorporateDataRows("Gov board").find((r) => r.ticker === ticker) ||
        listCorporateDataRows("Holdings").find((r) => r.ticker === ticker) ||
        listCorporateDataRows("All").find((r) => r.ticker === ticker);
      const gov = pushExtractToGovernance({
        ticker,
        market: stored?.market || market,
        name: stored?.name,
        extracted: body.extracted ?? stored?.extracted ?? null,
      });
      return NextResponse.json({
        ok: gov.ok,
        ticker: gov.ticker,
        pushed: gov.pushed,
        skipped: gov.skipped,
        reason: gov.reason,
        events_recorded: gov.events_recorded,
      });
    }

    if (action === "save") {
      if (!body.extracted) {
        return NextResponse.json(
          { ok: false, error: "extracted payload required" },
          { status: 400 },
        );
      }
      saveCorporateExtract({
        ticker,
        market,
        extracted: body.extracted,
        engine: "manual",
        status: "saved",
      });
      const gov = pushExtractToGovernance({
        ticker,
        market,
        extracted: body.extracted,
      });
      return NextResponse.json({
        ok: true,
        ticker,
        status: "saved",
        gov_push: gov,
      });
    }

    if (action === "scan") {
      const [scanned, concall] = await Promise.all([
        scanDocument(ticker, market),
        scanConcall(ticker, market),
      ]);
      return NextResponse.json({
        ok: true,
        ticker,
        found: scanned.found,
        blocked: scanned.blocked,
        document_url: scanned.document_url,
        document_title: scanned.document_title,
        date: scanned.date,
        concall_url: concall.concall_url,
        concall_title: concall.concall_title,
        concall_period: concall.concall_period,
        status: scanned.blocked ? "nse_blocked" : scanned.found ? "ok" : "no_document",
        error: scanned.error,
      });
    }

    if (action === "extract") {
      const stored =
        listCorporateDataRows("All").find((r) => r.ticker === ticker) ||
        listCorporateDataRows("Holdings").find((r) => r.ticker === ticker);
      const out = await extractDocument(
        ticker,
        market,
        stored?.document_url ?? null,
        stored?.document_title ?? null,
      );
      return NextResponse.json({
        ok: true,
        ticker,
        extract_ok: out.extract_ok,
        engine: out.engine,
        status: out.status,
        extracted: out.extracted,
        text_chars: out.text_chars,
        error: out.error,
        document_url: out.document_url,
        document_title: out.document_title,
        gov_push: out.gov_push,
      });
    }

    // run = scan board + Trendlyne concall + extract; merge concall into Extracted JSON
    const [scanned, concall] = await Promise.all([
      scanDocument(ticker, market),
      scanConcall(ticker, market),
    ]);
    const stored =
      listCorporateDataRows("All").find((r) => r.ticker === ticker) ||
      listCorporateDataRows("Holdings").find((r) => r.ticker === ticker) ||
      listCorporateDataRows("Gov board").find((r) => r.ticker === ticker);

    const boardUrl =
      scanned.document_url ||
      (scanned.blocked ? stored?.document_url ?? null : null);
    const boardTitle =
      scanned.document_title ||
      (scanned.blocked ? stored?.document_title ?? null : null);

    let boardExtracted: CorporateExtractPayload | null = null;
    let boardEngine: string | null = null;
    let boardStatus: string | null = null;
    let textChars = 0;
    let boardError: string | null = null;
    let govPush: ReturnType<typeof pushExtractToGovernance> | null = null;

    if (boardUrl) {
      const out = await extractDocument(ticker, market, boardUrl, boardTitle);
      boardExtracted = out.extracted;
      boardEngine = out.engine;
      boardStatus = out.status;
      textChars = out.text_chars;
      boardError = out.error;
      govPush = out.gov_push ?? null;
    }

    const merged = await attachConcallExtract(
      ticker,
      market,
      boardExtracted,
      boardEngine,
      boardStatus,
      concall.hit,
      boardUrl,
      boardTitle,
    );

    const blocked = scanned.blocked;
    const foundBoard = !!boardUrl;
    const extractOk = merged.extract_ok;
    let status = merged.status;
    let error: string | null = boardError;
    // DIN / board PDF is optional — current-year concall alone is a successful Scan.
    if (blocked && !foundBoard && !concall.found) {
      status = "nse_blocked";
      error = scanned.error || "NSE announcements blocked";
    } else if (blocked && foundBoard) {
      error = `NSE offline — used stored board PDF${concall.found ? " + concall" : ""}`;
    } else if (!foundBoard && concall.found) {
      status = "ok";
      error = null; // DIN optional
    } else if (foundBoard && concall.found) {
      status = "ok";
      error = boardError;
    } else if (!foundBoard && !concall.found) {
      status = "no_document";
      error = scanned.error || "No board PDF or current-year concall";
    } else if (foundBoard && !concall.found) {
      status = merged.status || "ok";
      error = boardError || "Board PDF only — no current-year concall";
    }

    return NextResponse.json({
      ok: true,
      ticker,
      found: foundBoard || concall.found,
      blocked,
      extract_ok: extractOk || concall.found,
      engine: merged.engine,
      status,
      extracted: merged.extracted,
      text_chars: textChars,
      error,
      document_url: boardUrl,
      document_title: boardTitle,
      concall_url: concall.concall_url,
      concall_title: concall.concall_title,
      concall_period: concall.concall_period,
      concall_date: concall.concall_date,
      gov_push: govPush,
      din_optional: true,
    });
  } catch (e) {
    // Never 500 on Akamai / HTTP2 / NSE transport — soft status for the UI
    if (isNseTransportFailure(e) || e instanceof NseAnnouncementsBlockedError) {
      markNseBlocked();
      let concall = {
        concall_url: null as string | null,
        concall_title: null as string | null,
        concall_period: null as string | null,
      };
      try {
        const mkt =
          CORPORATE_DATA_SEED.find((s) => s.ticker === ticker)?.market ||
          loadHoldings().find((h) => h.ticker.toUpperCase() === ticker)?.market ||
          "NSE";
        concall = await scanConcall(ticker, mkt);
      } catch {
        /* ignore */
      }
      const stored =
        listCorporateDataRows("All").find((r) => r.ticker === ticker) ||
        listCorporateDataRows("Holdings").find((r) => r.ticker === ticker);
      if (stored?.document_url) {
        try {
          const mkt = stored.market || "NSE";
          const out = await extractDocument(
            ticker,
            mkt,
            stored.document_url,
            stored.document_title,
          );
          return NextResponse.json({
            ok: true,
            ticker,
            found: true,
            blocked: true,
            extract_ok: out.extract_ok,
            engine: out.engine,
            status: out.status,
            extracted: out.extracted,
            text_chars: out.text_chars,
            error: "NSE/Akamai blocked — used stored board PDF + Trendlyne concall",
            document_url: out.document_url,
            document_title: out.document_title,
            concall_url: concall.concall_url,
            concall_title: concall.concall_title,
            concall_period: concall.concall_period,
          });
        } catch {
          /* fall through */
        }
      }
      return NextResponse.json({
        ok: true,
        ticker,
        found: false,
        blocked: true,
        extract_ok: false,
        status: "nse_blocked",
        error:
          e instanceof Error
            ? e.message
            : "NSE blocked (Akamai) — concall-only if available",
        document_url: stored?.document_url ?? null,
        document_title: stored?.document_title ?? null,
        concall_url: concall.concall_url,
        concall_title: concall.concall_title,
        concall_period: concall.concall_period,
        extracted: null,
      });
    }
    const message = e instanceof Error ? e.message : "Corporate data failed";
    console.error("[corporate-data]", e);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
