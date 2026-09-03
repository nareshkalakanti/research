import { invalidateCompanyCache } from "./db";
import { upsertClassification } from "./classifications-write";
import { ensureCompanyAboutRow } from "./company-about-write";
import { saveCompanyBoard } from "./governance-write";
import { loadDinNameIndex, matchGrowwNameToDin } from "./gov-groww-map";
import { upsertMetrics } from "./metrics";
import { openSqliteNamed } from "./sqlite-utils";
import type { WebProfile } from "./web-mcap";
import { webProfileToQuote } from "./web-mcap";
import { ensureWebProfileSchema } from "./web-profile-schema";

export type ApplyWebProfileResult = {
  metrics: number;
  about: number;
  sector: number;
  people: number;
};

export function applyWebProfiles(
  profiles: WebProfile[],
  marketBy: Record<string, string>,
  opts?: { overwriteAbout?: boolean },
): ApplyWebProfileResult {
  ensureWebProfileSchema();
  const overwriteAbout = opts?.overwriteAbout === true;
  const quotes = profiles
    .map(webProfileToQuote)
    .filter((q): q is NonNullable<typeof q> => q != null);
  const metrics = upsertMetrics(quotes, marketBy);

  let about = 0;
  let sector = 0;
  let people = 0;
  const now = new Date().toISOString();

  for (const p of profiles) {
    const ticker = p.ticker.toUpperCase();
    ensureCompanyAboutRow(ticker, {
      name: p.matched_name || ticker,
      market: marketBy[ticker] || p.exchange || "NSE",
    });
  }

  const db = openSqliteNamed("company_about.db", { readonly: false, wal: true });
  try {
    db.pragma("busy_timeout = 8000");
    const upd = db.prepare(`
      UPDATE company_about SET
        name = CASE
          WHEN UPPER(TRIM(COALESCE(name, ''))) = ticker AND @name != '' THEN @name
          ELSE name
        END,
        about = CASE
          WHEN @overwrite = 1 AND @about != '' THEN @about
          WHEN TRIM(COALESCE(about, '')) = '' AND @about != '' THEN @about
          ELSE about
        END,
        company_sector = CASE
          WHEN @sector != '' THEN @sector
          ELSE company_sector
        END,
        company_industry = CASE
          WHEN @subsector != '' THEN @subsector
          ELSE company_industry
        END,
        ceo = CASE WHEN @ceo != '' THEN @ceo ELSE ceo END,
        managing_director = CASE
          WHEN @md != '' THEN @md
          ELSE managing_director
        END,
        founded_year = CASE
          WHEN @founded != '' THEN @founded
          ELSE founded_year
        END,
        source = 'tickertape-groww',
        fetched_at = @fetched_at
      WHERE ticker = @ticker
    `);

    const tx = db.transaction(() => {
      for (const p of profiles) {
        const ticker = p.ticker.toUpperCase();
        const res = upd.run({
          ticker,
          name: p.matched_name || ticker,
          about: p.about,
          overwrite: overwriteAbout ? 1 : 0,
          sector: p.sector,
          subsector: p.subsector,
          ceo: p.ceo,
          md: p.managing_director,
          founded: p.founded_year,
          fetched_at: now,
        });
        if (res.changes > 0) {
          if (p.about) about += 1;
          if (p.sector || p.subsector) sector += 1;
          if (p.ceo || p.managing_director || p.founded_year) people += 1;
        }
      }
    });
    tx();
  } finally {
    db.close();
  }

  const dinIndex = loadDinNameIndex();
  for (const p of profiles) {
    const ticker = p.ticker.toUpperCase();
    const market = marketBy[ticker] || p.exchange || "NSE";
    if (p.sector && p.subsector) {
      upsertClassification(ticker, market, {
        sector: p.sector,
        sub_sector: p.subsector,
      });
    }
    const seats = [];
    const pushPerson = (name: string, designation: string) => {
      const hit = matchGrowwNameToDin(name, dinIndex);
      seats.push({
        din: hit?.din ?? "",
        name,
        designation,
        category: "Executive",
        source: hit ? "groww_din_map" : "groww",
        as_of: "",
      });
    };
    if (p.ceo) pushPerson(p.ceo, "Chief Executive Officer");
    if (
      p.managing_director &&
      p.managing_director.trim().toLowerCase() !==
        (p.ceo || "").trim().toLowerCase()
    ) {
      pushPerson(p.managing_director, "Managing Director");
    }
    if (seats.length) {
      try {
        saveCompanyBoard({
          ticker,
          name: p.matched_name || ticker,
          market,
          seats,
          replaceSeats: false,
          protectDinBoard: true,
        });
      } catch {
        /* BSE / missing DIN board — profile still saved on company_about */
      }
    }
  }

  invalidateCompanyCache();
  return { metrics, about, sector, people };
}
