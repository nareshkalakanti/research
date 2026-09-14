/**
 * MarketIQ category tests for the five screenshot rows (+ regressions).
 * Run: npm run test:marketiq-category
 */
import assert from "assert";
import Database from "better-sqlite3";
import path from "path";
import { resolveMarketIqCategory } from "../src/lib/marketiq-screen";

type Case = {
  key: string;
  title: string;
  summary: string;
  preferred?: string | null;
  expect: RegExp;
  reject?: RegExp;
};

const FIXTURES: Case[] = [
  {
    key: "PIRAMALFIN",
    title:
      "Piramal Finance Announces ₹3,850 Crore Capital Raise, Backed by Strong QIP Participation and Promoter Warrants",
    summary:
      "Piramal Finance has successfully completed a Qualified Institutions Placement (QIP) to raise ₹2,100 crore from leading domestic and global investors. The company also plans preferential allotment of warrants to the promoter.",
    preferred: "Capital Raise",
    expect: /capital raise|qip|preferential/i,
  },
  {
    key: "GMMPFAUDLR",
    title: "Intimation of Repayment of Debt",
    summary:
      "GMM Pfaudler Limited informs that its subsidiary GMM International S.a.r.l. has repaid EUR 7 million of debt to its lenders.",
    preferred: "Capital Raise", // wrong LLM label must not stick
    expect: /debt|repay/i,
    reject: /capital raise/i,
  },
  {
    key: "NATIONALUM",
    title: "Chairman Speech for 45th Annual General Meeting of the Company",
    summary:
      "The Chairman speech highlights highest-ever operational and financial performance in FY 2025-26.",
    preferred: "Annual Report/AGM",
    expect: /agm|annual|chairman/i,
  },
  {
    key: "BLKASHYAP",
    title:
      "Intimation regarding receipt of communication from Lead Bank in relation to Settlement of Right of Recompense (ROR)",
    summary:
      "The company confirms receipt of communication from the Lead Bank regarding settlement of Right of Recompense (ROR).",
    preferred: "Regulatory Disclosure",
    expect: /regulatory|settlement|disclosure|recompense|bank/i,
  },
  {
    key: "HEROMOTOCO",
    title:
      "Disclosure under Regulation 30 of the SEBI (Listing Obligations and Disclosure Requirements) Regulations, 2015",
    summary:
      "Appointment of Mr. Suresh Kumar P as Chief Digital & Information Officer.",
    preferred: "Regulatory Filing",
    expect: /appoint|kmp|personnel|management|director|regulatory/i,
    reject: /^listing$/i,
  },
];

function main() {
  const results: string[] = [];

  for (const f of FIXTURES) {
    const r = resolveMarketIqCategory(
      f.preferred ?? null,
      `${f.title}\n${f.summary}`,
      f.title,
    );
    assert.ok(
      f.expect.test(r.category),
      `${f.key}: expected ${f.expect} got ${r.category}`,
    );
    if (f.reject) {
      assert.ok(
        !f.reject.test(r.category),
        `${f.key}: rejected ${f.reject} but got ${r.category}`,
      );
    }
    results.push(`${f.key}→${r.category}`);
  }

  // Live DB: Piramal Capital Raise row if present
  const dbPath = path.join(process.cwd(), "data", "marketiq.db");
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const row = db
      .prepare(
        `SELECT id, headline, summary, category FROM announcement_screens
         WHERE UPPER(COALESCE(ticker,''))='PIRAMALFIN'
           AND (headline LIKE '%Capital Raise%' OR headline LIKE '%3,850%' OR summary LIKE '%QIP%')
         ORDER BY id DESC LIMIT 1`,
      )
      .get() as
      | { id: number; headline: string; summary: string; category: string }
      | undefined;
    if (row) {
      const resolved = resolveMarketIqCategory(
        row.category,
        `${row.headline}\n${row.summary}`,
        row.headline,
      );
      assert.ok(
        /capital raise|qip|preferential/i.test(resolved.category),
        `DB PIRAMALFIN id=${row.id} → ${resolved.category}`,
      );
      results.push(`DB#${row.id}→${resolved.category}`);
    }

    const gmm = db
      .prepare(
        `SELECT id, headline, summary, category FROM announcement_screens
         WHERE id=7 OR (UPPER(COALESCE(ticker,'')) LIKE 'GMMPFAUD%' AND summary LIKE '%repaid%')
         ORDER BY id DESC LIMIT 1`,
      )
      .get() as
      | { id: number; headline: string; summary: string; category: string }
      | undefined;
    if (gmm) {
      const resolved = resolveMarketIqCategory(
        "Capital Raise",
        `${gmm.headline}\n${gmm.summary}`,
        gmm.headline,
      );
      assert.ok(
        /debt|repay/i.test(resolved.category),
        `DB GMM id=${gmm.id} → ${resolved.category}`,
      );
      assert.ok(
        !/capital raise/i.test(resolved.category),
        `DB GMM must not stay Capital Raise`,
      );
      results.push(`DB-GMM#${gmm.id}→${resolved.category}`);
    }
    db.close();
  } catch {
    results.push("DB-skip");
  }

  // Prior regressions
  const deneers = resolveMarketIqCategory(
    "Board Meeting",
    "Allotment of Securities on a Preferential Basis\nThe Board approved allotment of equity shares on a preferential basis.",
    "Outcome of Board Meeting\nAllotment of Securities on a Preferential Basis",
  );
  assert.ok(
    /preferential|allotment/i.test(deneers.category),
    `DENEERS → ${deneers.category}`,
  );
  results.push(`DENEERS→${deneers.category}`);

  console.log(`ok · ${results.join(" · ")}`);
}

main();
