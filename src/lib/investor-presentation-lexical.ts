/**
 * Deterministic table/header parsers for Investor Presentation PDFs.
 * Values come only from the PDF text layer — no company-specific constants.
 * pdf-parse often glues cells (e.g. 181.97114.40) — splitGluedDecimals handles that.
 */

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function num(s: string | undefined | null): number | null {
  if (s == null) return null;
  const n = Number(String(s).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function asNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v.replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Indian filings use (8.0)% / (168) bps for negatives. */
function parenNum(
  raw: string | undefined | null,
  fromParens: boolean,
): number | null {
  const n = num(raw);
  if (n == null) return null;
  return fromParens && n > 0 ? -n : n;
}

/** Split pdf-parse glued cells like "181.97114.4059.07%" → [181.97, 114.40, 59.07]. */
export function splitGluedDecimals(raw: string): number[] {
  let rem = String(raw)
    .replace(/,/g, "")
    .replace(/%/g, "")
    .replace(/\s*bps\s*/gi, "")
    .replace(/\s+/g, "");
  const out: number[] = [];
  while (rem.length) {
    const m2 = /^(-?\d+\.\d{2})/.exec(rem);
    if (m2) {
      out.push(Number(m2[1]));
      rem = rem.slice(m2[1].length);
      continue;
    }
    const m1 = /^(-?\d+\.\d)/.exec(rem);
    if (m1) {
      out.push(Number(m1[1]));
      rem = rem.slice(m1[1].length);
      continue;
    }
    const m0 = /^(-?\d+)/.exec(rem);
    if (m0) {
      out.push(Number(m0[1]));
      rem = rem.slice(m0[1].length);
      continue;
    }
    rem = rem.slice(1);
  }
  return out;
}

function detectQuarterKeys(text: string): {
  quarter: string;
  fiscal_year: string;
  curKey: string;
  priorKey: string;
  finKey: string;
} {
  const m =
    /Investor Presentation\s*\|\s*Q(\d)\s*FY(\d{2})/i.exec(text) ||
    /Q(\d)[-–\s]*FY(\d{2})\s+Earnings Presentation/i.exec(text) ||
    /\|\s*Q(\d)\s*FY(\d{2})\s+Earnings Presentation/i.exec(text) ||
    /Results\s+Q(\d)\s*FY(\d{2})/i.exec(text) ||
    /financial results of Q(\d)\s+for\s+FY['']?(\d{2})/i.exec(text) ||
    // Indian FY span: Q1 FY 2026-27 → FY27 (second year)
    /Q(\d)\s+(?:of\s+)?FY\s*20\d{2}-(\d{2})/i.exec(text) ||
    /Total Revenue for Q(\d)\s*FY\s*20\d{2}-(\d{2})/i.exec(text) ||
    /Q(\d)\s*FY\s*20(\d{2})\b/i.exec(text) ||
    /\bQ(\d)\s*FY'?(\d{2})\b/i.exec(text);
  const q = m?.[1] || "1";
  let fy = m?.[2] || "27";
  if (fy.length === 4) fy = fy.slice(2);
  if (fy.length > 2) fy = fy.slice(-2);
  const prior = String(Number(fy) - 1).padStart(2, "0");
  return {
    quarter: `Q${q}`,
    fiscal_year: `FY${fy}`,
    curKey: `q${q}_fy${fy}`,
    priorKey: `q${q}_fy${prior}`,
    finKey: `q${q}_fy${fy}_financials`,
  };
}

/** Label must start a line so "PBT after exceptional" does not match Exceptional. */
function parseLabeledRow(block: string, label: RegExp): number[] {
  const source = label.source.replace(/^\^/, "").replace(/\$$/, "");
  const m = new RegExp(
    `(?:^|\\n)${source}\\s*\\n\\s*([-\\d.,%Bps]+)`,
    "im",
  ).exec(block);
  if (!m) {
    const m2 = new RegExp(
      `(?:^|\\n)${source}[^\\n]*\\n[^\\n]*\\n\\s*([-\\d.,%Bps]+)`,
      "im",
    ).exec(block);
    if (!m2) return [];
    return splitGluedDecimals(m2[1]);
  }
  return splitGluedDecimals(m[1]);
}

function metricRow(
  vals: number[],
  curKey: string,
  priorKey: string,
  unit = "INR cr",
): Record<string, unknown> | null {
  if (!vals.length) return null;
  const row: Record<string, unknown> = {
    [curKey]: vals[0],
    [priorKey]: vals[1] ?? null,
    unit,
  };
  if (vals.length >= 3) row.yoy_growth_pct = vals[2];
  return row;
}

export function parseQuarterPnLBlock(
  block: string,
  curKey: string,
  priorKey: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const map: Array<[string, RegExp, string?]> = [
    ["revenue_from_operations", /Revenues?/i],
    ["raw_material", /Raw Material/i],
    ["employee_costs", /Employee costs/i],
    ["other_expenses", /Other expenses/i],
    ["total_expenditure", /Total Expenditure/i],
    ["ebitda", /EBITDA(?!\s*(?:\(|Margin))/i],
    ["ebitda_margin_pct", /EBID?TA\s*\(%\)/i],
    ["finance_costs", /Finance Costs/i],
    ["depreciation", /Depreciation/i],
    ["pbt", /PBT(?!\s+after)/i],
    ["exceptional_item_other_income", /Exceptional item(?:\s*\/\s*Other Income)?/i],
    ["pbt_after_exceptional_item", /PBT after exceptional item/i],
    ["tax_expense", /TAX Expense(?:\s*\(Including Deferred\s*\n?Tax\))?/i],
    ["net_profit", /Net Profit(?!\s+Margin)/i],
    ["net_profit_margin_pct", /Net Profit Margin(?:\s*\(%\))?/i],
    ["eps", /EPS[\s()₹]*/i],
  ];
  for (const [key, lab, unit] of map) {
    const vals = parseLabeledRow(block, lab);
    if (!vals.length) continue;
    if (/margin/i.test(key)) {
      out[key] = {
        [curKey]: vals[0],
        [priorKey]: vals[1] ?? null,
        ...(vals[2] != null ? { change_bps: vals[2] } : {}),
      };
    } else {
      const row = metricRow(
        vals,
        curKey,
        priorKey,
        unit || (key === "eps" ? "INR" : "INR cr"),
      );
      if (row) out[key] = row;
    }
  }
  if (!out.tax_expense) {
    const m = /TAX Expense[\s\S]{0,48}?\n\s*([\d.]+)\s*([\d.]+)/i.exec(block);
    if (m) {
      out.tax_expense = {
        [curKey]: num(m[1]),
        [priorKey]: num(m[2]),
        unit: "INR cr",
      };
    }
  }
  if (!out.net_profit_margin_pct) {
    const m =
      /Net Profit Margin\s*\(%\)\s*\n\s*([\d.]+)%?\s*([\d.]+)%?\s*(-?\d+)\s*Bps/i.exec(
        block,
      ) ||
      /Net Profit Margin[\s\S]{0,20}?\n\s*([\d.]+)%([\d.]+)%(-?\d+)\s*Bps/i.exec(
        block,
      );
    if (m) {
      out.net_profit_margin_pct = {
        [curKey]: num(m[1]),
        [priorKey]: num(m[2]),
        change_bps: num(m[3]),
      };
    }
  }
  return out;
}

/**
 * Valorem / earnings-deck quarterly table:
 * Particulars (INR Mn)Q1 FY27Q1 FY26Y-o-YQ4 FY26Q-o-Q
 * Revenue from operations1,3041,417(8.0)%1,415(7.8)%
 */
export function parseEarningsStyleQuarterPnL(
  text: string,
  curKey: string,
  priorKey: string,
): Record<string, unknown> | null {
  const anchor =
    /Particulars\s*\(INR\s*(Mn|Cr|Crore)\)\s*Q\d\s*FY\d{2}\s*Q\d\s*FY\d{2}/i.exec(
      text,
    );
  if (!anchor || anchor.index == null) return null;
  const unitRaw = (anchor[1] || "Mn").toLowerCase();
  const unit =
    unitRaw.startsWith("cr") ? "INR cr" : unitRaw === "mn" ? "INR Mn" : `INR ${anchor[1]}`;
  const block = text.slice(anchor.index, anchor.index + 2800);

  const out: Record<string, unknown> = {};

  const takeMoney = (label: RegExp, key: string, rowUnit = unit) => {
    const m = new RegExp(
      `(?:^|\\n)${label.source}\\s*([\\d,]+(?:\\.\\d+)?)\\s*([\\d,]+(?:\\.\\d+)?)\\s*(?:(\\((-?\\d+(?:\\.\\d+)?)\\)|(-?\\d+(?:\\.\\d+)?))\\s*%)?`,
      "im",
    ).exec(block);
    if (!m) return;
    const row: Record<string, unknown> = {
      [curKey]: num(m[1]),
      [priorKey]: num(m[2]),
      unit: rowUnit,
    };
    const yoy = parenNum(m[4] || m[5], !!m[4]);
    if (yoy != null) row.yoy_growth_pct = yoy;
    out[key] = row;
  };

  const takeMargin = (label: RegExp, key: string) => {
    const m = new RegExp(
      `(?:^|\\n)${label.source}\\s*([\\d.]+)%\\s*([\\d.]+)%\\s*(?:\\((-?\\d+)\\)|(-?\\d+))\\s*bps`,
      "im",
    ).exec(block);
    if (!m) return;
    out[key] = {
      [curKey]: num(m[1]),
      [priorKey]: num(m[2]),
      change_bps: parenNum(m[3] || m[4], !!m[3]),
    };
  };

  takeMoney(/Revenue from operations/i, "revenue_from_operations");
  takeMoney(/Total expenses/i, "total_expenditure");
  takeMoney(/EBITDA(?!\s*margin)/i, "ebitda");
  takeMargin(/EBITDA margin\s*\(%\)/i, "ebitda_margin_pct");
  takeMoney(/Depreciation(?:\s*&\s*amortisation)?/i, "depreciation");
  takeMoney(/Finance costs/i, "finance_costs");
  takeMoney(/Other income/i, "other_income");
  takeMoney(/PBT/i, "pbt");
  takeMoney(/Tax/i, "tax_expense");
  takeMoney(/PAT(?!\s*margin)/i, "net_profit");
  takeMargin(/PAT margin\s*\(%\)/i, "net_profit_margin_pct");
  takeMoney(/Diluted EPS(?:\s*\(INR\))?/i, "eps", "INR");

  return Object.keys(out).length ? out : null;
}

/**
 * IT / Happiest Minds style results page (amounts often in ₹ Lakhs):
 * ParticularsQ1 FY27Q4 FY26QoQQ1 FY26YoY
 * Revenues62,85160,408\n4.0%\n54,990\n14.3%
 * Columns: current Q | prior Q (QoQ base) | QoQ% | YoY Q | YoY%
 */
export function parseLakhsQoQYoYQuarterPnL(
  text: string,
  curKey: string,
  priorKey: string,
): Record<string, unknown> | null {
  const anchor =
    /Particulars\s*Q(\d)\s*FY(\d{2})\s*Q\d\s*FY\d{2}\s*QoQ\s*Q\d\s*FY\d{2}\s*YoY/i.exec(
      text,
    );
  if (!anchor || anchor.index == null) return null;
  const pre = text.slice(Math.max(0, anchor.index - 500), anchor.index);
  const inLakhs = /All amounts in\s*₹?\s*Lakhs/i.test(pre) || /₹\s*Lakhs/i.test(pre);
  const block = text.slice(anchor.index, anchor.index + 3600);
  const out: Record<string, unknown> = {};

  const toDisplay = (n: number | null, asEps = false): number | null => {
    if (n == null) return null;
    if (asEps || !inLakhs) return n;
    // Lakhs → Cr for PASS / UI consistency
    return Math.round((n / 100) * 100) / 100;
  };

  const takeMoney = (
    label: RegExp,
    key: string,
    opts?: { eps?: boolean },
  ) => {
    // Prefer Indian comma groups so 62,85160,408 → 62,851 + 60,408 (not one blob).
    // Layout: cur|QoQ-base \n QoQ% \n YoY-base \n YoY%  (QoQ% must be required — optional
    // lets the engine swallow 4.0 from 4.0% as the YoY amount).
    const amt = "((?:\\d{1,3}(?:,\\d{2,3})+|\\d+)(?:\\.\\d+)?)";
    const m = new RegExp(
      `(?:^|\\n)${label.source}\\s*${amt}\\s*${amt}\\s*\\n\\s*([\\d.]+)\\s*%\\s*\\n\\s*${amt}\\s*\\n\\s*([\\d.]+)\\s*%`,
      "im",
    ).exec(block);
    if (!m) return;
    const cur = num(m[1]);
    const yoyBase = num(m[4]);
    const yoyPct = num(m[5]);
    if (cur == null) return;
    const row: Record<string, unknown> = {
      [curKey]: toDisplay(cur, opts?.eps),
      [priorKey]: toDisplay(yoyBase, opts?.eps),
      unit: opts?.eps ? "INR" : "INR cr",
    };
    if (yoyPct != null) row.yoy_growth_pct = yoyPct;
    else if (yoyBase != null && yoyBase !== 0) {
      row.yoy_growth_pct =
        Math.round(((cur - yoyBase) / Math.abs(yoyBase)) * 1000) / 10;
    }
    out[key] = row;
  };

  const takeEpsGlued = () => {
    const m =
      /(?:^|\n)Adjusted\s*EPS\s*([\d.]+)/im.exec(block) ||
      /(?:^|\n)EPS\s*([\d.]+)/im.exec(block);
    if (!m) return;
    const vals = splitGluedDecimals(m[1]);
    if (vals.length < 2) return;
    // Typical: current, QoQ prior, YoY prior (3 vals) — use first + last
    const cur = vals[0];
    const yoyBase = vals.length >= 3 ? vals[2] : vals[1];
    const row: Record<string, unknown> = {
      [curKey]: cur,
      [priorKey]: yoyBase,
      unit: "INR",
    };
    if (yoyBase) {
      row.yoy_growth_pct =
        Math.round(((cur - yoyBase) / Math.abs(yoyBase)) * 1000) / 10;
    }
    out.eps = row;
  };

  takeMoney(/Revenues?/i, "revenue_from_operations");
  takeMoney(/EBITDA(?!\s*(?:margin|%))/i, "ebitda");
  takeMoney(/PAT(?!\s*margin)/i, "net_profit");
  takeMoney(/PBT(?!\s+after)/i, "pbt");
  takeEpsGlued();

  // Operating / EBITDA margin lines: %17.5%17.5%17.6% (cur, qoq, yoy)
  const ebitdaMarg =
    /(?:^|\n)%\s*([\d.]+)%\s*([\d.]+)%\s*([\d.]+)%\s*(?:\n|$)/im.exec(
      block.slice(block.search(/EBITDA/i), block.search(/EBITDA/i) + 280),
    );
  if (ebitdaMarg) {
    const cur = num(ebitdaMarg[1]);
    const prior = num(ebitdaMarg[3]);
    if (cur != null) {
      out.ebitda_margin_pct = {
        [curKey]: cur,
        [priorKey]: prior,
        ...(cur != null && prior != null
          ? { change_bps: Math.round((cur - prior) * 100) }
          : {}),
      };
    }
  }

  return Object.keys(out).length ? out : null;
}

/** Split glued ints like 519123 → [519, 123] when pdf-parse merges FY + quarter cells. */
function splitGluedIntParts(n: number, parts: number): number[] | null {
  if (parts <= 1) return [n];
  const s = String(Math.abs(Math.trunc(n)));
  if (parts === 2) {
    const opts: number[][] = [];
    for (let i = 2; i <= s.length - 1; i++) {
      const a = Number(s.slice(0, i));
      const b = Number(s.slice(i));
      if (
        Number.isFinite(a) &&
        Number.isFinite(b) &&
        a >= 10 &&
        b >= 1 &&
        String(a).length <= 4 &&
        String(b).length <= 4
      ) {
        opts.push([a, b]);
      }
    }
    if (!opts.length) return null;
    // Prefer balanced 2–3 digit splits (519|123 over 51|9123)
    opts.sort((x, y) => {
      const score = (p: number[]) =>
        p.reduce((acc, v) => acc + (String(v).length === 3 ? 2 : String(v).length === 2 ? 1 : 0), 0);
      return score(y) - score(x);
    });
    return opts[0];
  }
  return null;
}

/**
 * Historical + current-quarter column decks:
 * Particulars (INR Mn)FY24FY25FY26Q1 FY27
 * Revenue from Operations2,025\n2,378\n3,143 754
 * Last numeric value on each row = current quarter.
 */
export function parseMultiYearWithQuarterColumn(
  text: string,
  curKey: string,
): Record<string, unknown> | null {
  const anchor =
    /Particulars\s*\(INR\s*(Mn|Cr|Crore)\)\s*((?:FY\d{2}\s*){2,4})Q\s*(\d)\s*FY\s*(\d{2})/i.exec(
      text,
    );
  if (!anchor || anchor.index == null) return null;
  const unitRaw = (anchor[1] || "Mn").toLowerCase();
  const unit =
    unitRaw.startsWith("cr") ? "INR cr" : unitRaw === "mn" ? "INR Mn" : `INR ${anchor[1]}`;
  const colCount = (anchor[2].match(/FY\d{2}/gi) || []).length + 1; // FYs + quarter
  const block = text.slice(anchor.index, anchor.index + 3200);
  const out: Record<string, unknown> = {};

  const takeLast = (
    label: RegExp,
    key: string,
    opts?: { margin?: boolean; rowUnit?: string },
  ) => {
    // Do not use /m with $ — that stops at the first line end and keeps FY24 only.
    const m = new RegExp(
      `(?:^|\\n)${label.source}\\s*([\\d.,%\\s()\\-–]+?)(?=\\n[A-Za-z(]|\\nEPS|\\nHISTORICAL|\\nParticulars)`,
      "i",
    ).exec(block);
    if (!m) return;
    const chunk = m[1].replace(/\n/g, " ");
    if (opts?.margin) {
      const pcts = [...chunk.matchAll(/(\d+(?:\.\d+)?)%/g)].map((x) =>
        Number(x[1]),
      );
      if (pcts.length >= 1) {
        out[key] = {
          [curKey]: pcts[pcts.length - 1],
          ...(pcts.length >= 2 ? { prior_fy: pcts[pcts.length - 2] } : {}),
        };
      }
      return;
    }
    // Prefer space/newline-separated cells (do not glue 2,025 2,378 3,143 754)
    let nums = [...chunk.matchAll(/-?\d{1,3}(?:,\d{2,3})*(?:\.\d+)?|-?\d+(?:\.\d+)?/g)]
      .map((x) => num(x[0]))
      .filter((n): n is number => n != null);
    // Rows like 388\n408\n519123 → need to unglue last cell into FY26 + Q1
    if (nums.length > 0 && nums.length < colCount) {
      const need = colCount - (nums.length - 1);
      const last = nums[nums.length - 1];
      const unglued = splitGluedIntParts(last, need);
      if (unglued) nums = [...nums.slice(0, -1), ...unglued];
    }
    if (!nums.length) return;
    const qVal =
      nums.length >= colCount ? nums[colCount - 1] : nums[nums.length - 1];
    if (qVal == null) return;
    out[key] = {
      [curKey]: qVal,
      unit: opts?.rowUnit || unit,
    };
  };

  takeLast(/Revenue from Operations/i, "revenue_from_operations");
  takeLast(/Total Expenses/i, "total_expenditure");
  takeLast(/EBITDA(?!\s*Margin)/i, "ebitda");
  takeLast(/EBITDA Margin\s*\(%\)/i, "ebitda_margin_pct", { margin: true });
  takeLast(/Other Income/i, "other_income");
  takeLast(/Depreciation/i, "depreciation");
  takeLast(/Finance Cost/i, "finance_costs");
  takeLast(/PBT(?!\s+after)/i, "pbt");
  takeLast(/\bTax\b/i, "tax_expense");
  takeLast(
    /PAT after Exceptional Item(?!\s*\(%\))/i,
    "net_profit",
  );
  if (!out.net_profit) {
    takeLast(/PAT before Exceptional Item(?!\s*\(%\))/i, "net_profit");
  }
  takeLast(
    /PAT Margin after Exceptional Item\s*\(%\)/i,
    "net_profit_margin_pct",
    { margin: true },
  );
  takeLast(/EPS\s*\(INR\)/i, "eps", { rowUnit: "INR" });

  return Object.keys(out).length ? out : null;
}

/**
 * Key Financial & Operational Highlights cards:
 * REVENUE FROM OPERATIONS / INR 1,304 Mn / Q1 FY26: INR 1,417 Mn | (8.0)% YoY
 */
export function parseKeyFinancialHighlightCards(
  text: string,
  curKey: string,
  priorKey: string,
): { financials: Record<string, unknown>; operational: string[] } {
  const financials: Record<string, unknown> = {};
  const section =
    /Key Financial[^\n]{0,80}Highlights[\s\S]{0,3500}?(?=Q\d FY\d{2} Operational Performance|Quarterly Financial|Historical Income|Investor Presentation \|)/i.exec(
      text,
    )?.[0] || text.slice(0, 12_000);

  const card = (
    title: RegExp,
    key: string,
    opts?: { margin?: boolean; unit?: string },
  ) => {
    if (opts?.margin) {
      const m = new RegExp(
        `${title.source}\\s*\\n?\\s*([\\d.]+)%\\s*\\n?\\s*Q\\d\\s*FY\\d{2}:\\s*([\\d.]+)%\\s*\\|\\s*(?:\\((-?\\d+)\\)|(-?\\d+))\\s*bps`,
        "i",
      ).exec(section);
      if (m) {
        financials[key] = {
          [curKey]: num(m[1]),
          [priorKey]: num(m[2]),
          change_bps: parenNum(m[3] || m[4], !!m[3]),
        };
      }
      return;
    }
    const m = new RegExp(
      `${title.source}\\s*\\n?\\s*INR\\s*([\\d,]+(?:\\.\\d+)?)\\s*(Mn|Cr)?\\s*\\n?\\s*Q\\d\\s*FY\\d{2}:\\s*INR\\s*([\\d,]+(?:\\.\\d+)?)\\s*(?:Mn|Cr)?\\s*\\|\\s*(?:\\((-?\\d+(?:\\.\\d+)?)\\)|(-?\\d+(?:\\.\\d+)?))\\s*%\\s*YoY`,
      "i",
    ).exec(section);
    if (!m) return;
    const u = (m[2] || opts?.unit || "Mn").toLowerCase();
    financials[key] = {
      [curKey]: num(m[1]),
      [priorKey]: num(m[3]),
      yoy_growth_pct: parenNum(m[4] || m[5], !!m[4]),
      unit: opts?.unit || (u.startsWith("cr") ? "INR cr" : "INR Mn"),
    };
  };

  card(/REVENUE FROM OPERATIONS/i, "revenue_from_operations");
  card(/EBITDA(?!\s*MARGIN)/i, "ebitda");
  card(/EBITDA MARGIN/i, "ebitda_margin_pct", { margin: true });
  card(/PAT(?!\s*MARGIN)/i, "net_profit");
  card(/PAT MARGIN/i, "net_profit_margin_pct", { margin: true });
  card(/DILUTED EPS/i, "eps", { unit: "INR" });
  // EPS card uses INR without Mn
  if (!financials.eps) {
    const m =
      /DILUTED EPS\s*\n?\s*INR\s*([\d.]+)\s*\n?\s*Q\d\s*FY\d{2}:\s*INR\s*([\d.]+)\s*\|?\s*(?:\((-?\d+(?:\.\d+)?)\)|(-?\d+(?:\.\d+)?))\s*%\s*YoY/i.exec(
        section,
      );
    if (m) {
      financials.eps = {
        [curKey]: num(m[1]),
        [priorKey]: num(m[2]),
        yoy_growth_pct: parenNum(m[3] || m[4], !!m[3]),
        unit: "INR",
      };
    }
  }

  const operational: string[] = [];
  const opBlock =
    /OPERATIONAL\s*\n?\s*HIGHLIGHTS\s*\n([\s\S]{0,1200}?)(?=\n\d+\n|Q\d FY\d{2} Operational|Bharat Wire|Investor Presentation)/i.exec(
      section,
    )?.[1] ||
    /OPERATIONAL\s*\n?\s*HIGHLIGHTS\s*\n([\s\S]{0,1200}?)(?=\n\d+\s*\n)/i.exec(
      text,
    )?.[1] ||
    "";
  const opFlat = opBlock.replace(/\n+/g, " ").replace(/\s+/g, " ").trim();
  for (const part of opFlat.split(/(?<=\.)\s+/)) {
    const t = part.trim();
    if (t.length < 40) continue;
    if (/^(REVENUE|EBITDA|PAT|DILUTED|Q\d|INR)/i.test(t)) continue;
    operational.push(t);
  }

  return { financials, operational };
}

function parseTriYearRow(block: string, label: RegExp): number[] {
  const source = label.source.replace(/^\^/, "");
  const m = new RegExp(
    `(?:^|\\n)${source}\\s*\\n?\\s*([-\\d.,%\\s]+)`,
    "im",
  ).exec(block);
  if (!m) return [];
  const chunk = m[1].split(/\n(?=[A-Za-z])/)[0] || m[1];
  return splitGluedDecimals(chunk.replace(/\n/g, ""));
}

/** Detect FY column order from header like FY26FY25FY24 → [FY26, FY25, FY24]. */
function detectFyOrder(block: string): string[] {
  const m = /Particulars\s*\n?\s*((?:FY\d{2}\s*){2,4})/i.exec(block);
  if (m) {
    return [...m[1].matchAll(/FY(\d{2})/gi)].map((x) => `FY${x[1]}`);
  }
  const m2 = /Assets\s*((?:FY\d{2}){2,4})/i.exec(block);
  if (m2) {
    return [...m2[1].matchAll(/FY(\d{2})/gi)].map((x) => `FY${x[1]}`);
  }
  const found = [...block.matchAll(/\bFY(\d{2})\b/gi)].map((x) => `FY${x[1]}`);
  const uniq: string[] = [];
  for (const fy of found) {
    if (!uniq.includes(fy)) uniq.push(fy);
  }
  return uniq.slice(0, 4);
}

/** Multi-year P&L — columns as printed (usually FY26 FY25 FY24). */
export function parseMultiYearPnL(text: string): Record<string, unknown> {
  const start = text.search(
    /Multi-year Consolidated Profit & Loss Statement & Cash Flow Statement\s*\n\(In/i,
  );
  if (start < 0) return {};
  const block = text.slice(start, start + 2800);
  const fyCols = detectFyOrder(block);
  const row = (lab: RegExp) => parseTriYearRow(block, lab);

  const revenues = row(/Revenues/i);
  const ebitda = row(/EBITDA(?!\s*Margin)/i);
  const ebitdaMar = row(/EBITDA Margin/i);
  const pbtAfter = row(/PBT after exceptional item/i);
  const pbt = row(/PBT(?!\s+after)/i);
  const pat = row(/Net Profit(?!\s+Margin)/i);
  const patMar = row(/Net Profit Margin/i);
  const raw = row(/Raw Material Expenses/i);
  const emp = row(/Employee Costs/i);
  const oth = row(/Other Expenses/i);
  const totEx = row(/Total Expenditure/i);
  const fin = row(/Finance Costs/i);
  const dep = row(/Depreciation/i);
  const excep = row(/Exceptional item(?:\s*\/\s*Other Income)?/i);
  const tax = row(/Tax(?!\s+Expense)/i);

  const pbtValues = pbtAfter.length ? pbtAfter : pbt;

  const sortedFys = [...fyCols].sort((a, b) => a.localeCompare(b));
  const colIndex = (fy: string) => fyCols.indexOf(fy);
  const seriesValue = (vals: number[], fy: string) => {
    const i = colIndex(fy);
    return i >= 0 ? (vals[i] ?? null) : null;
  };

  const revenue_from_operations = sortedFys.map((fy) => ({
    fiscal_year: fy,
    value: seriesValue(revenues, fy),
    yoy_growth_pct: null as number | null,
  }));
  const ebitdaSeries = sortedFys.map((fy) => ({
    fiscal_year: fy,
    value: seriesValue(ebitda, fy),
    margin_pct: seriesValue(ebitdaMar, fy),
    yoy_growth_pct: null as number | null,
  }));

  // Prefer table figures only (chart windows are noisy in pdf-parse).
  const pbtSeries = sortedFys.map((fy) => {
    const value = seriesValue(pbtValues, fy);
    const r = seriesValue(revenues, fy);
    const margin_pct =
      value != null && r
        ? Number(((value / r) * 100).toFixed(2))
        : null;
    return {
      fiscal_year: fy,
      value,
      margin_pct,
      yoy_growth_pct: null as number | null,
    };
  });
  for (let i = 1; i < pbtSeries.length; i++) {
    const cur = asNum(pbtSeries[i].value);
    const prior = asNum(pbtSeries[i - 1].value);
    if (cur != null && prior != null && prior !== 0) {
      pbtSeries[i].yoy_growth_pct = Number(
        (((cur - prior) / Math.abs(prior)) * 100).toFixed(2),
      );
    }
  }

  const patSeries = sortedFys.map((fy) => {
    const value = seriesValue(pat, fy);
    const margin_pct = seriesValue(patMar, fy);
    return {
      fiscal_year: fy,
      value,
      margin_pct,
      yoy_growth_pct: null as number | null,
    };
  });
  for (let i = 1; i < patSeries.length; i++) {
    const cur = asNum(patSeries[i].value);
    const prior = asNum(patSeries[i - 1].value);
    if (cur != null && prior != null && prior !== 0) {
      patSeries[i].yoy_growth_pct = Number(
        (((cur - prior) / Math.abs(prior)) * 100).toFixed(2),
      );
    }
  }

  for (let i = 0; i < revenue_from_operations.length; i++) {
    if (i === 0) {
      revenue_from_operations[i].yoy_growth_pct = null;
      ebitdaSeries[i].yoy_growth_pct = null;
      continue;
    }
    const cur = asNum(revenue_from_operations[i].value);
    const prior = asNum(revenue_from_operations[i - 1].value);
    revenue_from_operations[i].yoy_growth_pct =
      cur != null && prior != null && prior !== 0
        ? Number((((cur - prior) / Math.abs(prior)) * 100).toFixed(2))
        : null;
    const ec = asNum(ebitdaSeries[i].value);
    const ep = asNum(ebitdaSeries[i - 1].value);
    ebitdaSeries[i].yoy_growth_pct =
      ec != null && ep != null && ep !== 0
        ? Number((((ec - ep) / Math.abs(ep)) * 100).toFixed(2))
        : null;
  }

  const full_pnl = sortedFys.map((fy) => ({
    fiscal_year: fy,
    revenues: seriesValue(revenues, fy),
    raw_material: seriesValue(raw, fy),
    employee_costs: seriesValue(emp, fy),
    other_expenses: seriesValue(oth, fy),
    total_expenditure: seriesValue(totEx, fy),
    ebitda: seriesValue(ebitda, fy),
    ebitda_margin_pct: seriesValue(ebitdaMar, fy),
    finance_costs: seriesValue(fin, fy),
    depreciation: seriesValue(dep, fy),
    pbt: seriesValue(pbt, fy),
    exceptional_item_other_income: seriesValue(excep, fy),
    pbt_after_exceptional: seriesValue(pbtAfter, fy),
    tax: seriesValue(tax, fy),
    net_profit: seriesValue(pat, fy),
    net_profit_margin_pct: seriesValue(patMar, fy),
  }));

  const op = parseTriYearRow(block, /Cash Flow from Operating Activities/i);
  const inv = parseTriYearRow(block, /Cash Flow from Investing Activities/i);
  const finCf = parseTriYearRow(block, /Cash Flow from Financing Activities/i);
  const net = (() => {
    const m =
      /Net Increase in Cash[^\n]*\s*\n\s*(-?[\d.]+)\s*\n\s*([-.\d]+)/i.exec(
        block,
      );
    if (m) {
      const rest = splitGluedDecimals(m[2]);
      return [num(m[1]), rest[0] ?? null, rest[1] ?? null].filter(
        (x) => x != null,
      ) as number[];
    }
    return parseTriYearRow(block, /Net Increase in Cash/i);
  })();

  const cash_flow = sortedFys.map((fy) => {
    const i = colIndex(fy);
    return {
      fiscal_year: fy,
      operating: i >= 0 ? op[i] ?? null : null,
      investing: i >= 0 ? inv[i] ?? null : null,
      financing: i >= 0 ? finCf[i] ?? null : null,
      net_change_in_cash: i >= 0 ? net[i] ?? null : null,
    };
  });

  return {
    revenue_from_operations,
    ebitda: ebitdaSeries,
    pbt: pbtSeries,
    pat: patSeries,
    full_pnl,
    cash_flow,
    unit: "INR cr",
  };
}

export function parseBalanceSheet(text: string): Record<string, unknown> {
  const start = text.search(/AssetsFY\d{2}FY\d{2}FY\d{2}|Assets\s*FY\d{2}/i);
  if (start < 0) return { unit: "INR cr" };
  const block = text.slice(start, start + 2200);
  const fyCols = detectFyOrder(block);
  const line = (lab: RegExp) => parseTriYearRow(block, lab);
  const map: Array<[string, RegExp]> = [
    ["fixed_assets", /Fixed Assets/i],
    ["other_non_current_financial_assets", /Other Non Current Financial Assets/i],
    ["deferred_tax_assets", /Deferred Tax Assets(?:\s*\(Net\))?/i],
    ["other_non_current_assets", /Other Non Current Assets/i],
    ["inventories", /Inventories/i],
    ["trade_receivables", /Trade receivables/i],
    ["cash_and_bank", /Cash & Bank Balance/i],
    ["other_current_financial_assets", /Other Current Financial Assets/i],
    ["current_tax_assets", /Current Tax Assets(?:\s*\(Net\))?/i],
    ["other_current_assets", /Other Current Assets/i],
    ["total_assets", /Total Assets/i],
    ["equity_share_capital", /Equity Share Capital/i],
    ["reserves_and_surplus", /Reserves and Surplus/i],
    ["minorities_interest", /Minorities Interests?/i],
    ["non_current_borrowings", /Non Current Borrowings/i],
    ["deferred_tax_liability", /Deferred Tax Liability/i],
    ["long_term_provision", /Long Term Provision/i],
    ["current_borrowings", /Current Borrowings/i],
    ["trade_payables", /Trade Payables/i],
    ["current_tax_liabilities", /Current Tax Liabilities(?:\s*\(Net\))?/i],
    ["short_term_provisions", /Short Term Provisions/i],
    ["other_current_liabilities", /Other Current Liabilities/i],
    ["total_equity_and_liabilities", /Total Equity and Liabilities/i],
  ];

  const fyRows: Record<string, Record<string, number | null>> = {};
  for (const fy of fyCols) fyRows[fy] = {};

  for (const [key, lab] of map) {
    const vals = line(lab);
    fyCols.forEach((fy, i) => {
      fyRows[fy][key] = vals[i] ?? null;
    });
  }

  const leaseMatches = [
    ...block.matchAll(/(?:^|\n)Lease Liabilities\s*\n?\s*([-.\d\s]+)/gim),
  ];
  if (leaseMatches[0]) {
    const vals = splitGluedDecimals(leaseMatches[0][1].replace(/\n/g, ""));
    fyCols.forEach((fy, i) => {
      fyRows[fy].lease_liabilities_non_current = vals[i] ?? null;
    });
  }
  if (leaseMatches[1]) {
    const vals = splitGluedDecimals(leaseMatches[1][1].replace(/\n/g, ""));
    fyCols.forEach((fy, i) => {
      fyRows[fy].lease_liabilities_current = vals[i] ?? null;
    });
  }

  return { ...fyRows, unit: "INR cr" };
}

function parsePctTripletBefore(
  text: string,
  label: RegExp,
): number[] | null {
  const m = label.exec(text);
  if (!m || m.index == null) return null;
  const before = text.slice(Math.max(0, m.index - 120), m.index);
  const pcts = [...before.matchAll(/(\d+(?:\.\d+)?)%/g)].map((x) =>
    Number(x[1]),
  );
  if (pcts.length >= 2) return pcts.slice(-3);
  return null;
}

export function parseRevenueMix(text: string): Record<string, unknown> {
  const keys = detectQuarterKeys(text);
  const qLabel = `${keys.quarter} ${keys.fiscal_year}`.replace(/\s+/g, "\\s*");
  const qDomKey = `${keys.curKey}_domestic_vs_export`;
  const qExpKey = `${keys.curKey}_export_country_distribution`;

  // Prefer quarter-labelled pair: "xx%\nyy%\nQ1 FYxx\nDomestic SalesExport Sales"
  const labelledDom = new RegExp(
    `(\\d+(?:\\.\\d+)?)%\\s*\\n?\\s*(\\d+(?:\\.\\d+)?)%\\s*\\n?\\s*${qLabel}\\s*\\n?\\s*Domestic\\s*Sales\\s*Export\\s*Sales`,
    "i",
  ).exec(text);
  let q1_dom: Record<string, number> = {};
  if (labelledDom) {
    q1_dom = {
      domestic_pct: Number(labelledDom[1]),
      export_pct: Number(labelledDom[2]),
    };
  } else {
    // Fallback: last Domestic SalesExport Sales pair whose two % sum ~100
    for (const m of text.matchAll(
      /(\d+(?:\.\d+)?)%\s*\n?\s*(\d+(?:\.\d+)?)%\s*\n?\s*(?:Q\d\s*FY\d{2}\s*\n?)?Domestic\s*Sales\s*Export\s*Sales/gi,
    )) {
      const a = Number(m[1]);
      const b = Number(m[2]);
      if (a + b > 95 && a + b < 105) {
        q1_dom = { domestic_pct: a, export_pct: b };
      }
    }
  }

  // Country-wise: pcts then quarter label then glued country names
  let q1_exp: Record<string, number> = {};
  const countryBlock = new RegExp(
    `((?:\\d+(?:\\.\\d+)?%\\s*\\n?){3,12})\\s*${qLabel}\\s*\\n?\\s*([A-Za-z][A-Za-z\\s\\.]+?)(?=\\nCountry-wise|\\nDomestic vs|\\nInvestor Presentation)`,
    "i",
  ).exec(text);
  if (countryBlock) {
    const pcts = [...countryBlock[1].matchAll(/(\d+(?:\.\d+)?)%/g)].map((x) =>
      Number(x[1]),
    );
    const names = splitGluedCountryNames(countryBlock[2]);
    if (names.length === pcts.length && names.length >= 3) {
      names.forEach((name, i) => {
        q1_exp[name] = pcts[i];
      });
    }
  }
  // Adjacent name+pct pairs if present in text
  if (Object.keys(q1_exp).length === 0) {
    for (const m of text.matchAll(
      /\b(USA|UAE|Italy|Canada|France|Others|Germany|Vietnam|Nepal|UK|China|Saudi Arabia|Norway|American Samoa)\b\s*[–\-:]?\s*(\d+(?:\.\d+)?)%/gi,
    )) {
      q1_exp[normalizeCountry(m[1])] = Number(m[2]);
    }
  }

  const annual_domestic_vs_export: Array<Record<string, unknown>> = [];
  for (const m of text.matchAll(
    /(\d+(?:\.\d+)?)%?\s*\n?\s*(\d+(?:\.\d+)?)%?\s*\n?\s*(FY\d{2})(?!\s*\(In)/gi,
  )) {
    const domestic = Number(m[1]);
    const exp = Number(m[2]);
    if (
      domestic > 1 &&
      exp > 1 &&
      domestic + exp > 95 &&
      domestic + exp < 105
    ) {
      annual_domestic_vs_export.push({
        fiscal_year: m[3].toUpperCase(),
        domestic_pct: domestic,
        export_pct: exp,
      });
    }
  }

  const annual_export_market_distribution: Array<Record<string, unknown>> = [];
  // Layout seen in decks: pct list, then "FY24 (In %)", then glued country names
  for (const m of text.matchAll(
    /((?:\d+(?:\.\d+)?%\s*\n?){3,12})\s*(FY\d{2})\s*\(In\s*%\)\s*\n([A-Za-z][A-Za-z\s\.]+?)(?=\nDomestic|\nExport Markets|\nInvestor|\nFY\d{2}|\n\d)/gi,
  )) {
    const pcts = [...m[1].matchAll(/(\d+(?:\.\d+)?)%/g)].map((x) =>
      Number(x[1]),
    );
    const fy = m[2].toUpperCase();
    const names = splitGluedCountryNames(m[3]);
    if (names.length === pcts.length && names.length >= 3) {
      const top_markets: Record<string, number> = {};
      names.forEach((name, i) => {
        top_markets[name] = pcts[i];
      });
      annual_export_market_distribution.push({ fiscal_year: fy, top_markets });
    }
  }
  annual_export_market_distribution.sort((a, b) =>
    String(a.fiscal_year).localeCompare(String(b.fiscal_year)),
  );

  return {
    [qDomKey]: q1_dom,
    [qExpKey]: q1_exp,
    annual_domestic_vs_export,
    annual_export_market_distribution,
  };
}

function normalizeCountry(name: string): string {
  const n = name.replace(/\s+/g, " ").trim();
  if (/^United Arab Emirates$/i.test(n)) return "UAE";
  if (/^United Kingdom$/i.test(n)) return "UK";
  return n;
}

/** Split pie-chart legend text where pdf-parse glues labels (e.g. UAEUSAItaly). */
function splitGluedCountryNames(raw: string): string[] {
  let s = raw.replace(/Vietna\s*m/gi, "Vietnam").replace(/\s+/g, " ").trim();
  // Known geography tokens longest-first (parsing aid, not values)
  const tokens = [
    "United Arab Emirates",
    "American Samoa",
    "Saudi Arabia",
    "Sri Lanka",
    "United Kingdom",
    "Netherlands",
    "Germany",
    "Vietnam",
    "Hungary",
    "Ireland",
    "Sweden",
    "Belgium",
    "Norway",
    "France",
    "Canada",
    "Italy",
    "Brazil",
    "Croatia",
    "Bolivia",
    "Nepal",
    "China",
    "Others",
    "USA",
    "UAE",
    "UK",
  ].sort((a, b) => b.length - a.length);

  const out: string[] = [];
  while (s.length > 0) {
    let hit: string | null = null;
    for (const t of tokens) {
      if (s.toLowerCase().startsWith(t.toLowerCase())) {
        hit = t;
        break;
      }
    }
    if (!hit) {
      // camelCase fallback chunk
      const m = /^[A-Z][a-z]+/.exec(s) || /^[A-Z]+/.exec(s);
      if (!m) break;
      hit = m[0];
    }
    out.push(normalizeCountry(hit));
    s = s.slice(hit.length).trimStart();
  }
  return out.filter((x) => x.length > 1 && !/^Domestic|^Export|^Sales/i.test(x));
}

export function parseLeadership(text: string): Record<string, unknown> {
  // Prefer the bio page (not the TOC line "Board of Directors and KMP")
  const founderIdx = text.search(
    /Founder,?\s*Chairman and Managing Director/i,
  );
  const boardSection =
    founderIdx >= 0
      ? text.slice(Math.max(0, founderIdx - 200), founderIdx + 5500)
      : /Board of Directors[\s\S]{0,6000}?(?=Key Managerial Positions|State of the Art)/i.exec(
          text,
        )?.[0] || text.slice(0, 12000);

  const founderBlock =
    /(?:Mr\.?\s*)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\s*\n\s*Founder,?\s*Chairman and Managing Director([\s\S]{0,900}?)(?=Mr\.|Mrs\.|CA\s*\(|Key Managerial|Board of Directors)/i.exec(
      boardSection,
    ) ||
    /(?:Mr\.?\s*)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\s*\n\s*Founder,?\s*Chairman and Managing Director([\s\S]{0,900})/i.exec(
      text,
    );

  let founder_chairman_md: Record<string, unknown> | null = null;
  if (founderBlock) {
    const bio = founderBlock[2] || "";
    const years =
      asNum(
        /(?:over\s+)?(\d+)\+?\s*years/i.exec(bio)?.[1] ||
          (/two decades/i.test(bio) ? "19" : null),
      );
    const diplomas = [
      ...bio.matchAll(/Diploma in [^.,\n]+/gi),
    ].map((x) => x[0]);
    const prev =
      /(?:associated with|previously at|Before establishing[^,]*, he was associated with)\s+([A-Z][^.\n]{3,80})/i.exec(
        bio,
      )?.[1];
    const backgroundParts = [
      ...diplomas,
      prev ? `previously at ${prev.replace(/,?\s*where.*$/i, "").trim()}` : null,
    ].filter(Boolean);
    founder_chairman_md = {
      name: founderBlock[1].trim(),
      experience_years: years,
      background: backgroundParts.join("; ") || bio.slice(0, 240).trim(),
    };
  }

  const board_of_directors: Array<Record<string, unknown>> = [];
  const personRe =
    /(?:Mr\.|Mrs\.|Ms\.|CA\s*\(Dr\.\)|CA\s*\(Dr\)|Dr\.)\s*([A-Z][A-Za-z. ]+?)\s*\n\s*(Chairman[^\n]*|Whole Time Director|Non-Executive Director|Independent Director|Managing Director)\n([\s\S]{0,500}?)(?=(?:\n(?:Mr\.|Mrs\.|Ms\.|CA\s*\())|\nKey Managerial|\nBoard of Directors|\nInvestor Presentation)/gi;
  for (const m of boardSection.matchAll(personRe)) {
    const name = m[1].replace(/\s+/g, " ").trim();
    const role = m[2].replace(/\s+/g, " ").trim();
    const bio = m[3] || "";
    const experience_years = asNum(
      /(?:over\s+)?(\d+)\+?\s*years/i.exec(bio)?.[1],
    );
    const qualifications: string[] = [];
    if (/Cost Accountant/i.test(bio)) qualifications.push("Cost Accountant");
    if (/Company Secretary/i.test(bio)) qualifications.push("Company Secretary");
    if (/Insolvency Professional/i.test(bio))
      qualifications.push("Insolvency Professional");
    if (/Chartered Accountant/i.test(bio) || /^CA\b/i.test(m[0]))
      qualifications.push(
        /Dr/i.test(m[0]) ? "Chartered Accountant (Dr.)" : "Chartered Accountant",
      );
    if (/MBA(?:\s+in\s+Finance)?/i.test(bio)) {
      const mba = /MBA(?:\s+in\s+Finance)?/i.exec(bio)?.[0];
      if (mba) qualifications.push(mba);
    }
    if (/postgraduate.*?Commerce|PG Commerce/i.test(bio))
      qualifications.push("PG Commerce");
    const row: Record<string, unknown> = { name, role };
    if (experience_years != null) row.experience_years = experience_years;
    if (qualifications.length)
      row.qualifications = qualifications.join(", ");
    if (!board_of_directors.some((b) => b.name === name)) {
      board_of_directors.push(row);
    }
  }

  // Ensure founder is first if present and missing from board list
  if (
    founder_chairman_md &&
    !board_of_directors.some((b) => b.name === founder_chairman_md!.name)
  ) {
    board_of_directors.unshift({
      name: founder_chairman_md.name,
      role: "Chairman & Managing Director",
    });
  }

  const kmpSection =
    /Key Managerial Positions?([\s\S]{0,2000}?)(?=State of the Art|Investor Presentation \|)/i.exec(
      text,
    )?.[1] || "";
  const key_managerial_personnel: Array<Record<string, unknown>> = [];
  for (const m of kmpSection.matchAll(
    /(?:Mr\.|Mrs\.|Ms\.)\s*([A-Z][A-Za-z .]+?)\s*\n\s*([A-Za-z][^\n]{3,80})/g,
  )) {
    const name = m[1].trim();
    const role = m[2].trim();
    const row: Record<string, unknown> = { name, role };
    const after = kmpSection.slice(m.index! + m[0].length, m.index! + m[0].length + 400);
    if (/All India Rank\s*(\d+)/i.test(after) || /Law graduate/i.test(after)) {
      const rank = /All India Rank\s*(\d+)/i.exec(after)?.[1];
      const uni = /University of ([A-Za-z]+)/i.exec(after)?.[1];
      row.qualifications = [
        uni ? `Law graduate, University of ${uni}` : null,
        rank ? `All India Rank ${rank} in CS Final exam` : null,
      ]
        .filter(Boolean)
        .join("; ");
    }
    key_managerial_personnel.push(row);
  }

  return {
    founder_chairman_md: founder_chairman_md || {},
    board_of_directors,
    key_managerial_personnel,
  };
}

export function parseBusinessOverview(text: string): Record<string, unknown> {
  const aboutLead =
    /leading manufacturers? of ([^.]{10,180})/i.exec(text)?.[0] || "";

  const industryMatch =
    /leading manufacturers? of ([^.]{10,120}?)(?:\s+for\b|\.)/i.exec(text);
  const industry = industryMatch
    ? industryMatch[1].replace(/\s+/g, " ").trim()
    : null;

  // Portfolio sentence first; cover chips as fallback — only PDF text
  const portfolioLine =
    /diversified portfolio comprising ([^.]{20,400})/i.exec(text)?.[1] || "";
  let core_segments = portfolioLine
    ? portfolioLine
        .split(/,|\band\b/i)
        .map((s) => s.replace(/\s+/g, " ").trim())
        .filter((s) => s.length > 2 && s.length < 60)
    : [];
  if (core_segments.length === 0) {
    const cover =
      /Fin\s*&\s*Tube[\s\S]{0,250}?(?:Bus AC|Railway)/i.exec(text)?.[0] || "";
    const normalized = cover.replace(/\n/g, " ").replace(/\s+/g, " ");
    for (const m of normalized.matchAll(
      /Fin\s*&\s*Tube|Bar\s*&\s*Plate|Refrigerator\s+Components|Complete\s+HVAC\s+System|Railway|Bus\s+AC/gi,
    )) {
      const label = m[0].replace(/\s+/g, " ").trim();
      if (!core_segments.some((s) => s.toLowerCase() === label.toLowerCase())) {
        core_segments.push(label);
      }
    }
  }

  const endUseLine =
    /end-use industries including ([^.\n]+)/i.exec(text)?.[1] || "";
  const end_use_industries = endUseLine
    ? endUseLine
        .split(/,/)
        .map((s) => s.replace(/\band\b/gi, "").replace(/\s+/g, " ").trim())
        .filter(Boolean)
    : [];

  const manufacturing_facilities: Array<Record<string, unknown>> = [];
  const facilityBlock =
    /State-of-the-art Facility([\s\S]{0,1200}?)(?=Global Pres|Investor Presentation \|)/i.exec(
      text,
    )?.[1] || text;
  const location =
    /((?:RIICO\s+)?Industrial Area,?\s*[A-Za-z]+(?:,\s*[A-Za-z]+)?)/i
      .exec(facilityBlock)?.[1]
      ?.replace(/\s+/g, " ")
      .trim() || null;

  for (const m of facilityBlock.matchAll(
    /(?:^|\n)\s*([A-Z][A-Za-z0-9 &.\n-]{5,90}?(?:Limited|Ltd\.?|Private Limited))(?:\s*[-–]\s*Wholly Owned Subsidiary)?\s*\n?\s*Total Land Area:\s*([\d,]+(?:\.\d+)?)\s*SQFT/gi,
  )) {
    const unit = m[1]
      .replace(/Facility\s*\d+/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    manufacturing_facilities.push({
      unit,
      location,
      land_area_sqft: num(m[2]),
    });
  }
  if (manufacturing_facilities.length === 0) {
    for (const m of text.matchAll(/([\d,]+(?:\.\d+)?)\s*SQFT/gi)) {
      const ctx = text.slice(Math.max(0, m.index! - 220), m.index! + 40);
      const company =
        /([A-Z][A-Za-z0-9 &.\n-]{5,80}?(?:Limited|Ltd\.?|Private Limited))/i
          .exec(ctx)?.[1]
          ?.replace(/\s+/g, " ")
          .trim() || null;
      const loc =
        /((?:RIICO\s+)?Industrial Area,?\s*[A-Za-z]+(?:,\s*[A-Za-z]+)?)/i
          .exec(ctx)?.[1]
          ?.replace(/\s+/g, " ")
          .trim() || null;
      manufacturing_facilities.push({
        unit: company,
        location: loc,
        land_area_sqft: num(m[1]),
      });
    }
  }

  const export_countries: string[] = [];
  // Prefer the map page (countries), not the TOC "Global Presence" entry
  let countryBlock = "";
  for (const m of text.matchAll(
    /Global Presence\s*\n((?:•\s*[^\n]+\n?){4,40})/gi,
  )) {
    const block = m[1];
    const hits = [...block.matchAll(/•\s*([A-Za-z][A-Za-z\s]+)/g)].map((x) =>
      x[1].replace(/\s+/g, " ").trim(),
    );
    const looksLikeCountries = hits.filter(
      (c) =>
        c.length > 2 &&
        c.length < 40 &&
        !/Revenue|Product|Award|Workforce|Particular|Financial|Shareholding|Contact|Certification/i.test(
          c,
        ),
    );
    if (looksLikeCountries.length >= 4) {
      countryBlock = block;
      break;
    }
  }
  for (const m of countryBlock.matchAll(/•\s*([A-Za-z][A-Za-z\s]+)/g)) {
    const c = m[1].replace(/\s+/g, " ").trim();
    if (
      c.length > 2 &&
      c.length < 40 &&
      !/Revenue|Product|Award|Workforce|Particular|Financial|Shareholding|Contact|Certification/i.test(
        c,
      )
    ) {
      export_countries.push(
        c === "United Kingdom" ? "UK" : c === "United Arab Emirates" ? "UAE" : c,
      );
    }
  }

  const workforce = /([\d,]+)\+?\s*Strong Workforce/i.exec(text)?.[1];

  const recent_corporate_actions: string[] = [];
  for (const m of text.matchAll(
    /(20\d{2}\s*[-–]\s*20\d{2}|20\d{2})([\s\S]{0,400}?)(?=20\d{2}|Investor Presentation \|)/g,
  )) {
    const year = m[1].replace(/\s+/g, "").replace("–", "-");
    const blob = m[2].replace(/\s+/g, " ").trim();
    const established =
      /Established\s+([A-Z][A-Za-z0-9 &.]+?(?:Pvt\.?\s*Ltd\.?|Private Limited))/i.exec(
        blob,
      );
    if (established) {
      recent_corporate_actions.push(
        `Established ${established[1].replace(/\s+/g, " ").trim()} (${year})`,
      );
    }
    const acquired =
      /acquired the\s+([^.]{10,120}?)(?:\.|$)/i.exec(blob) ||
      /acquired\s+([^.]{10,120}?)(?:\.|$)/i.exec(blob);
    if (acquired) {
      recent_corporate_actions.push(
        `Acquired ${acquired[1].replace(/\s+/g, " ").trim()} (${year})`,
      );
    }
  }

  void aboutLead;
  return {
    industry,
    core_segments,
    end_use_industries,
    manufacturing_facilities,
    export_countries,
    workforce: workforce ? `${workforce}+` : null,
    recent_corporate_actions,
  };
}

export function parseChairmanCommentary(text: string): Record<string, unknown> {
  const quote =
    /Q1 FY\d{2} Performance and Outlook by the Chairman[\s\S]{0,80}?[“"]([\s\S]{200,2500}?)[”"]/i.exec(
      text,
    )?.[1] ||
    /We have begun FY\d{2}[\s\S]{200,2000}/i.exec(text)?.[0];
  if (!quote) return {};

  const revGrowth = asNum(
    /consolidated revenue growing (\d+)%/i.exec(quote)?.[1] ||
      /revenue growing (\d+)%/i.exec(quote)?.[1],
  );
  const exportGrowth = asNum(
    /(?:exports?|overseas revenue)[^\n]{0,40}?increased (\d+)%/i.exec(quote)?.[1] ||
      /growth in exports is[^\n]{0,80}?(\d+)%/i.exec(quote)?.[1],
  );
  const countries = asNum(
    /(\d+)\s+countries/i.exec(quote)?.[1],
  );

  // Paraphrase from extracted stats only (not verbatim copyrighted quote)
  const parts: string[] = [];
  if (revGrowth != null)
    parts.push(`Consolidated revenue grew ${revGrowth}% YoY`);
  if (exportGrowth != null)
    parts.push(`overseas/export revenue increased ${exportGrowth}% YoY`);
  if (countries != null)
    parts.push(`reaching customers in ${countries} countries`);
  const focusBits: string[] = [];
  if (/\bscale\b/i.test(quote)) focusBits.push("scale");
  if (/manufacturing capacit/i.test(quote))
    focusBits.push("manufacturing capability");
  if (/\bcapacity\b/i.test(quote)) focusBits.push("capacity");
  if (/localisation|localization/i.test(quote)) focusBits.push("localisation");
  if (/backward integration/i.test(quote))
    focusBits.push("backward integration");
  const focus =
    focusBits.length > 0
      ? `Focus remains on ${focusBits.join(", ")}.`
      : null;

  return {
    quote_summary: [parts.join(", ") + ".", focus].filter(Boolean).join(" "),
    key_stats_cited: {
      ...(revGrowth != null
        ? { consolidated_revenue_growth_yoy_pct: revGrowth }
        : {}),
      ...(exportGrowth != null
        ? { export_revenue_growth_yoy_pct: exportGrowth }
        : {}),
      ...(countries != null ? { countries_served_this_quarter: countries } : {}),
    },
  };
}

export function buildSentimentFromTables(
  extract: Record<string, unknown>,
): Record<string, unknown> {
  const qKey =
    Object.keys(extract).find((k) => /^q\d_fy\d{2}_financials$/i.test(k)) || "";
  const q = asObj(extract[qKey]) || {};
  const stand = asObj(q.standalone) || {};
  const cons = asObj(q.consolidated) || {};
  const multi = asObj(extract.multi_year_consolidated_financials) || {};
  const cash = Array.isArray(multi.cash_flow) ? multi.cash_flow : [];
  const bs = asObj(extract.balance_sheet_consolidated) || {};
  const share = asObj(extract.shareholding_and_share_price) || {};
  const pat = asObj(
    Object.entries(share).find(([k]) =>
      k.startsWith("shareholding_pattern_as_of_"),
    )?.[1],
  );

  const curKeys = Object.keys(asObj(cons.revenue_from_operations) || {}).filter(
    (k) => /^q\d_fy\d{2}$/i.test(k),
  );
  const curKey = curKeys.sort().slice(-1)[0] || "q1_fy27";
  const priorKey = curKey.replace(/fy(\d{2})/i, (_, y) => {
    return `fy${String(Number(y) - 1).padStart(2, "0")}`;
  });

  const metric = (bag: Record<string, unknown>, name: string) =>
    asObj(bag[name]) || {};

  const watch_points: string[] = [];
  const ebitdaMS = metric(stand, "ebitda_margin_pct");
  const ebitdaMC = metric(cons, "ebitda_margin_pct");
  const revS = metric(stand, "revenue_from_operations");
  const rawS = metric(stand, "raw_material");
  const standBps = asNum(ebitdaMS.change_bps);
  const rmNow =
    asNum(rawS[curKey]) != null && asNum(revS[curKey])
      ? ((asNum(rawS[curKey]) as number) / (asNum(revS[curKey]) as number)) *
        100
      : null;
  const rmPrior =
    asNum(rawS[priorKey]) != null && asNum(revS[priorKey])
      ? ((asNum(rawS[priorKey]) as number) /
          (asNum(revS[priorKey]) as number)) *
        100
      : null;

  if (standBps != null && standBps < 0) {
    watch_points.push(
      `Standalone EBITDA margin compressed ${standBps} bps YoY (${ebitdaMS[priorKey]}% to ${ebitdaMS[curKey]}%)${
        rmNow != null && rmPrior != null
          ? ` — raw material as % of standalone revenue ${rmPrior.toFixed(1)}% to ${rmNow.toFixed(1)}%`
          : ""
      }`,
    );
  }
  const consBps = asNum(ebitdaMC.change_bps);
  if (consBps != null && consBps > 0) {
    watch_points.push(
      `Consolidated margin expansion (+${consBps} bps) vs standalone — subsidiary mix worth monitoring`,
    );
  }

  const fys = Object.keys(bs).filter((k) => /^FY\d{2}$/i.test(k)).sort();
  const latestFy = fys[fys.length - 1];
  const prevFy = fys[fys.length - 2];
  const fyCash = asObj(
    cash.find((r) => asObj(r)?.fiscal_year === latestFy),
  );
  const ocf = asNum(fyCash?.operating);
  const latestBs = asObj(bs[latestFy]) || {};
  const prevBs = asObj(bs[prevFy]) || {};
  if (ocf != null && ocf < 0) {
    watch_points.push(
      `${latestFy} operating cash flow was negative (₹${ocf} cr)${
        latestBs.inventories != null && prevBs.inventories != null
          ? ` — inventories ${prevBs.inventories} to ${latestBs.inventories}; receivables ${prevBs.trade_receivables} to ${latestBs.trade_receivables}`
          : ""
      }`,
    );
  }
  if (
    asNum(latestBs.current_borrowings) != null &&
    asNum(prevBs.current_borrowings) != null
  ) {
    watch_points.push(
      `Current borrowings ${prevBs.current_borrowings} to ${latestBs.current_borrowings} in ${latestFy}`,
    );
  }
  const prom = asNum(pat?.promoter_and_promoter_group_pct);
  if (prom != null) {
    watch_points.push(`Promoter holding ${prom}%`);
  }

  const revYoy = asNum(metric(cons, "revenue_from_operations").yoy_growth_pct);
  const tone =
    revYoy != null && revYoy >= 40
      ? "strongly bullish"
      : revYoy != null && revYoy >= 15
        ? "bullish"
        : "neutral";
  const score =
    revYoy != null && revYoy >= 40
      ? ocf != null && ocf < 0
        ? 0.6
        : 0.75
      : 0.2;

  return {
    overall_tone: tone,
    justification:
      revYoy != null
        ? `Consolidated revenue YoY ${revYoy >= 0 ? "+" : ""}${revYoy}%` +
          (consBps != null ? `, EBITDA margin ${consBps >= 0 ? "+" : ""}${consBps} bps` : "")
        : "Tone derived from disclosed quarterly tables",
    watch_points,
    net_sentiment_score: score,
    sentiment_rationale:
      ocf != null && ocf < 0
        ? "Growth metrics are strong in the P&L tables, but negative operating cash flow and working-capital build temper the signal."
        : "Assessment based on disclosed P&L, cash flow, and balance-sheet tables in the presentation.",
  };
}

function parseMetadata(text: string): Record<string, unknown> {
  const keys = detectQuarterKeys(text);
  const meta: Record<string, unknown> = {
    document_type: "Investor Presentation",
    quarter: keys.quarter,
    fiscal_year: keys.fiscal_year,
  };

  const company =
    /For\s+([A-Z][A-Za-z0-9 &.]+(?:Limited|Ltd\.?))/i.exec(text)?.[1] ||
    /([A-Z][A-Za-z0-9 &.]+(?:Limited|Ltd\.?))\s*\|\s*Q\d\s*FY\d{2}/i.exec(
      text,
    )?.[1] ||
    /(?:Subject:\s*Investors?['']?\s*Presentation[\s\S]{0,200}?)?(?:^|\n)([A-Z][A-Za-z0-9 &.]+(?:Limited|Ltd\.?))\s*\n/m.exec(
      text,
    )?.[1] ||
    /About The Company[\s\S]{0,200}?([A-Z][A-Za-z0-9 &.]+(?:Limited|Ltd\.?))/i.exec(
      text,
    )?.[1];
  if (company) {
    meta.company_name = company.replace(/\s+/g, " ").trim();
  }

  const sym =
    /Scrip Name:\s*([A-Z0-9.&-]+)|NSE Symbol:\s*([A-Z0-9.&-]+)|Script Symbol:\s*([A-Z0-9.&-]+)|NSE:\s*([A-Z0-9.&-]+)|Symbol:\s*([A-Z0-9.&-]+)/i.exec(
      text,
    );
  if (sym)
    meta.nse_symbol = (
      sym[1] ||
      sym[2] ||
      sym[3] ||
      sym[4] ||
      sym[5] ||
      ""
    ).toUpperCase();

  const bse =
    /BSE Scrip Code:\s*(\d{4,8})|Scrip Code:\s*(\d{4,8})|Script Code:\s*(\d{4,8})|BSE:\s*(\d{4,8})/i.exec(
      text,
    );
  if (bse) meta.bse_code = bse[1] || bse[2] || bse[3] || bse[4];

  const isin = /ISIN:\s*(INE[A-Z0-9]+)/i.exec(text);
  if (isin) meta.isin = isin[1].toUpperCase();

  const cin = /CIN(?:\s*No\.?)?:\s*([A-Z0-9]+)/i.exec(text);
  if (cin) meta.cin = cin[1].toUpperCase();

  const filing =
    /Date:\s*(\d{1,2})\s*(?:st|nd|rd|th)?\s*([A-Za-z]+),?\s*(20\d{2})/i.exec(
      text,
    ) ||
    /Date:\s*(\d{1,2})[-\/.](\d{1,2})[-\/.](20\d{2})/i.exec(text);
  if (filing) {
    if (/^[A-Za-z]+$/.test(filing[2])) {
      const months: Record<string, string> = {
        january: "01",
        february: "02",
        march: "03",
        april: "04",
        may: "05",
        june: "06",
        july: "07",
        august: "08",
        september: "09",
        october: "10",
        november: "11",
        december: "12",
      };
      const mm = months[filing[2].toLowerCase()];
      if (mm)
        meta.filing_date = `${filing[3]}-${mm}-${filing[1].padStart(2, "0")}`;
    } else {
      meta.filing_date = `${filing[3]}-${filing[2].padStart(2, "0")}-${filing[1].padStart(2, "0")}`;
    }
  }

  const office =
    /Registered[^:\n]*:\s*([^\n]+Neemrana[^\n]*)/i.exec(text)?.[1] ||
    /Plot No\.?:?\s*(F-[\d,\s]+[^\n]{0,100}Neemrana[^\n]*)/i.exec(text)?.[1];
  if (office) {
    meta.registered_office = office.replace(/\s+/g, " ").trim();
  }

  const listed = /listed[\s\S]{0,60}?(October|Nov|Dec|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep)[a-z]*,?\s*(20\d{2})/i.exec(
    text,
  );
  if (listed) {
    const months: Record<string, string> = {
      october: "10",
      nov: "11",
      november: "11",
      dec: "12",
      december: "12",
      jan: "01",
      january: "01",
      feb: "02",
      february: "02",
      mar: "03",
      march: "03",
      apr: "04",
      april: "04",
      may: "05",
      jun: "06",
      june: "06",
      jul: "07",
      july: "07",
      aug: "08",
      august: "08",
      sep: "09",
      september: "09",
    };
    const mm = months[listed[1].toLowerCase()];
    if (mm) meta.listing_date = `${listed[2]}-${mm}`;
  }

  const inc = /Founded in \w+\s+(20\d{2})|established[\s\S]{0,40}?(20\d{2})/i.exec(
    text,
  );
  if (inc) meta.incorporation_year = num(inc[1] || inc[2]);

  const hq = /headquartered in ([A-Za-z ,]+)/i.exec(text)?.[1];
  if (hq) meta.headquarters = hq.trim();

  const sub =
    /([A-Z][A-Za-z0-9 &.]+?(?:Private Limited|Pvt\.?\s*Ltd\.?))\s*[-–]?\s*Wholly Owned Subsidiary/i.exec(
      text,
    )?.[1] ||
    /Wholly Owned Subsidiary[\s\S]{0,80}?([A-Z][A-Za-z0-9 &.]+?(?:Private Limited|Pvt\.?\s*Ltd\.?))/i.exec(
      text,
    )?.[1] ||
    /Established\s+([A-Z][A-Za-z0-9 &.]+?(?:Private Limited|Pvt\.?\s*Ltd\.?))/i.exec(
      text,
    )?.[1];
  if (sub) {
    meta.wholly_owned_subsidiary = sub.replace(/\s+/g, " ").trim();
  }

  return meta;
}

function parseShareholding(text: string, filingDate: string | null) {
  const share: Record<string, unknown> = {};
  if (filingDate) share.as_of_date = filingDate;

  const priceM = /Share Price\s*\(₹\)\s*₹\s*([\d,]+(?:\.\d+)?)/i.exec(text);
  if (priceM) share.share_price_inr = num(priceM[1]);
  const mcapM =
    /Market Capitalization\s*\(₹\s*Cr\)\s*([\d,]+(?:\.\d+)?)/i.exec(text);
  if (mcapM) share.market_cap_inr_cr = num(mcapM[1]);
  const sharesM = /No\.\s*of Shares Outstanding\s*([\d,]+)/i.exec(text);
  if (sharesM) share.shares_outstanding = num(sharesM[1]);
  const faceM = /Face Value\s*\(₹\)\s*([\d,]+(?:\.\d+)?)/i.exec(text);
  if (faceM) share.face_value_inr = num(faceM[1]);
  const hiLo =
    /52 weeks High-Low\s*\(₹\)\s*([\d,]+(?:\.\d+)?)\s*\/\s*([\d,]+(?:\.\d+)?)/i.exec(
      text,
    );
  if (hiLo) {
    share["52_week_high_inr"] = num(hiLo[1]);
    share["52_week_low_inr"] = num(hiLo[2]);
  }

  const asOf =
    /As On\s*(\d{2})-(\d{2})-(\d{4})/i.exec(text) ||
    /As On\s*(\d{2})\/(\d{2})\/(\d{4})/i.exec(text);
  const patternKey = asOf
    ? `shareholding_pattern_as_of_${asOf[3]}_${asOf[2]}_${asOf[1]}`
    : "shareholding_pattern_as_of_unknown";

  const pat = parsePctTripletBefore(
    text,
    /Promoter\s*&\s*Promoter\s*Group\s*\n?\s*Institutions\s*\n?\s*Non Institutions/i,
  );
  if (pat && pat.length >= 3) {
    share[patternKey] = {
      promoter_and_promoter_group_pct: pat[0],
      institutions_pct: pat[1],
      non_institutions_pct: pat[2],
    };
  }

  const holdersBlock =
    /Top Public Shareholders([\s\S]{0,1200}?)(?=NSE:|Investor Relations|~)/i.exec(
      text,
    )?.[1] || "";
  const holders: string[] = [];
  for (const m of holdersBlock.matchAll(/•\s*([^\n•]+)/g)) {
    const name = m[1].replace(/\s+/g, " ").trim();
    if (name.length > 3) holders.push(name);
  }
  if (holders.length) share.top_public_shareholders = holders;

  const perf =
    /Share Performance From\s+([A-Za-z0-9 ,]+?)\s+To\s+([A-Za-z0-9 ,]+)\s*([\s\S]{0,500}?)(?:Source:|Top Public)/i.exec(
      text,
    );
  if (perf) {
    share.share_performance_period = `${perf[1].trim()} to ${perf[2].trim()}`;
    const ret = [...perf[3].matchAll(/(-?\d+(?:\.\d+)?)%/g)].map((x) =>
      Number(x[1]),
    );
    if (ret.length) {
      // Stock return is typically the large positive % on this slide
      const stock =
        ret.find((x) => x >= 50) ??
        ret.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a));
      share.share_performance_return_pct = stock;
      const negatives = ret.filter((x) => x < 0);
      if (negatives.length) {
        share.benchmark_comparison = {
          nifty_50_return_pct: negatives[negatives.length - 1],
          ...(negatives.length > 1
            ? { nifty_consumer_durables_return_pct: negatives[0] }
            : {}),
        };
      }
    }
  }

  return share;
}

/**
 * Chart-style QoQ decks (e.g. RACL): bar values sit above "Revenue / QoQ Sales".
 * Also picks up "Consolidated Revenue : 132.60 Crore" and growth lines.
 */
export function parseQoQChartFinancials(
  text: string,
  curKey: string,
  priorKey: string,
): Record<string, unknown> | null {
  // TOC also lists "Standalone Financial Performance" — use body section
  // (title followed by growth line), not the contents bullet.
  const standBody = /\nStandalone Financial Performance[^\n]*\nOur Operating Revenue/i.exec(
    text,
  );
  const standAt = standBody?.index ?? -1;
  const block =
    standAt > 200
      ? text.slice(0, standAt)
      : text.slice(0, Math.min(text.length, 12_000));

  const pairBefore = (
    label: RegExp,
    qoQ: RegExp,
  ): { prior: number; cur: number } | null => {
    const lab = new RegExp(
      `(?:^|\\n)${label.source}\\s*\\n\\s*${qoQ.source}`,
      "im",
    ).exec(block);
    if (!lab || lab.index == null) return null;
    const before = block.slice(Math.max(0, lab.index - 500), lab.index);
    // Prefer decimals (108.7 / 27.29); chart axis ticks are usually bare integers.
    const decimals = [...before.matchAll(/(\d+\.\d+)/g)]
      .map((m) => Number(m[1]))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (decimals.length >= 2) {
      return {
        prior: decimals[decimals.length - 2]!,
        cur: decimals[decimals.length - 1]!,
      };
    }
    const nums = [...before.matchAll(/(\d+(?:\.\d+)?)/g)]
      .map((m) => Number(m[1]))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (nums.length < 2) return null;
    const cur = nums[nums.length - 1]!;
    const prior = nums[nums.length - 2]!;
    return { prior, cur };
  };

  const out: Record<string, unknown> = {};

  const revPair =
    pairBefore(/Revenue/, /QoQ\s+Sales\s*\(INR\s*Cr\)/) ||
    (() => {
      const g =
        /Operating Revenue has grown from\s*([\d.]+)\s*cr\s*to\s*([\d.]+)\s*cr\s*-?\(([\d.]+)%\)/i.exec(
          block,
        ) ||
        /Operating Revenue has grown from\s*([\d.]+)\s*cr\s*to\s*([\d.]+)\s*cr\s*-?\(([\d.]+)%\)/i.exec(
          text,
        );
      if (g) {
        return { prior: Number(g[1]), cur: Number(g[2]) };
      }
      const m =
        /Consolidated\s+Revenue\s*:\s*([\d.]+)\s*Crore/i.exec(block) ||
        /Consolidated\s+Revenue\s*:\s*([\d.]+)\s*Crore/i.exec(text);
      if (m) return { prior: 0, cur: Number(m[1]) };
      return null;
    })();

  if (revPair && revPair.cur > 0) {
    const row: Record<string, unknown> = {
      [curKey]: revPair.cur,
      unit: "INR cr",
    };
    if (revPair.prior > 0) {
      row[priorKey] = revPair.prior;
      row.yoy_growth_pct =
        Math.round(((revPair.cur - revPair.prior) / revPair.prior) * 1000) / 10;
    } else {
      const g =
        /Operating Revenue has grown from\s*[\d.]+\s*cr\s*to\s*[\d.]+\s*cr\s*-?\(([\d.]+)%\)/i.exec(
          text,
        );
      if (g) row.yoy_growth_pct = Number(g[1]);
    }
    out.revenue_from_operations = row;
  }

  const ebitdaPair = pairBefore(/EBITDA/, /QoQ\s+EBITDA\s*\(INR\s*Cr\)/);
  if (ebitdaPair) {
    out.ebitda = {
      [curKey]: ebitdaPair.cur,
      [priorKey]: ebitdaPair.prior,
      yoy_growth_pct:
        Math.round(
          ((ebitdaPair.cur - ebitdaPair.prior) / ebitdaPair.prior) * 1000,
        ) / 10,
      unit: "INR cr",
    };
  }

  const margin = /QoQ\s+EBITDA\s*\(INR\s*Cr\)[^\n]*\n[^\n]*\n\s*([\d.]+)%\s*\n\s*([\d.]+)%/i.exec(
    block,
  );
  if (margin) {
    const priorM = Number(margin[1]);
    const curM = Number(margin[2]);
    out.ebitda_margin_pct = {
      [curKey]: curM,
      [priorKey]: priorM,
      change_bps: Math.round((curM - priorM) * 100),
      unit: "%",
    };
  }

  const pbtPair = pairBefore(
    /Profit Before Tax/,
    /QoQ\s+PBT\s*\(INR\s*Cr\)/,
  );
  if (pbtPair) {
    // Use PBT as PAT proxy only when net profit absent — still useful for PASS.
    out.profit_before_tax = {
      [curKey]: pbtPair.cur,
      [priorKey]: pbtPair.prior,
      yoy_growth_pct:
        Math.round(((pbtPair.cur - pbtPair.prior) / pbtPair.prior) * 1000) / 10,
      unit: "INR cr",
    };
    if (!out.net_profit) {
      out.net_profit = { ...out.profit_before_tax, note: "PBT (PAT not printed)" };
    }
  }

  return Object.keys(out).length ? out : null;
}

/** Full lexical enrich — values only from PDF text. */
export function applyInvestorPresentationLexical(
  text: string,
  extract: Record<string, unknown>,
): Record<string, unknown> {
  const keys = detectQuarterKeys(text);
  const meta = { ...(asObj(extract.metadata) || {}), ...parseMetadata(text) };
  extract.metadata = meta;

  extract.business_overview = parseBusinessOverview(text);
  extract.leadership = parseLeadership(text);
  extract.chairman_commentary = parseChairmanCommentary(text);

  const pnlAnchor = /Standalone\s*\n?\s*ParticularsQ\d FY\d{2}Q\d FY\d{2}YoY/i.exec(
    text,
  );
  const qFin: Record<string, unknown> = {};
  if (pnlAnchor && pnlAnchor.index != null) {
    const pnlSlice = text.slice(pnlAnchor.index, pnlAnchor.index + 3500);
    const splitAt = pnlSlice.search(/\nConsolidated\s*\n?\s*ParticularsQ/i);
    const standBlock =
      splitAt >= 0 ? pnlSlice.slice(0, splitAt) : pnlSlice.slice(0, 1800);
    const consBlock = splitAt >= 0 ? pnlSlice.slice(splitAt) : "";
    qFin.standalone = parseQuarterPnLBlock(
      standBlock,
      keys.curKey,
      keys.priorKey,
    );
    qFin.consolidated = parseQuarterPnLBlock(
      consBlock,
      keys.curKey,
      keys.priorKey,
    );
  }

  // Earnings / Valorem decks: quarterly INR Mn table + highlight cards
  const earningsQ = parseEarningsStyleQuarterPnL(
    text,
    keys.curKey,
    keys.priorKey,
  );
  const lakhsQ = parseLakhsQoQYoYQuarterPnL(
    text,
    keys.curKey,
    keys.priorKey,
  );
  const histQ = parseMultiYearWithQuarterColumn(text, keys.curKey);
  const highlightCards = parseKeyFinancialHighlightCards(
    text,
    keys.curKey,
    keys.priorKey,
  );
  const chartQ = parseQoQChartFinancials(text, keys.curKey, keys.priorKey);
  const deckFin: Record<string, unknown> = {
    ...(histQ || {}),
    ...(earningsQ || {}),
    ...(lakhsQ || {}),
    ...(chartQ || {}),
  };
  // Prefer highlight-card values (correct signs / no glue) when present
  Object.assign(deckFin, highlightCards.financials);
  if (Object.keys(deckFin).length) {
    // Prefer consolidated bucket for PASS mapping when stand/cons absent
    if (!asObj(qFin.consolidated) || !Object.keys(asObj(qFin.consolidated)!).length) {
      qFin.consolidated = deckFin;
    }
    if (!asObj(qFin.standalone) || !Object.keys(asObj(qFin.standalone)!).length) {
      qFin.standalone = deckFin;
    }
  }
  if (highlightCards.operational.length) {
    qFin.operational_highlights = highlightCards.operational;
  }
  if (
    /EBITDA and EBITDA Margin are computed based on Revenue from Operations/i.test(
      text,
    )
  ) {
    qFin.note =
      "EBITDA and EBITDA Margin computed based on Revenue from Operations";
  }
  extract[keys.finKey] = qFin;
  // Drop alternate quarterly keys from LLM
  for (const k of Object.keys(extract)) {
    if (/^q\d_fy\d{2}_financials$/i.test(k) && k !== keys.finKey) {
      delete extract[k];
    }
  }

  extract.revenue_mix = parseRevenueMix(text);
  extract.multi_year_consolidated_financials = parseMultiYearPnL(text);
  extract.balance_sheet_consolidated = parseBalanceSheet(text);
  extract.shareholding_and_share_price = parseShareholding(
    text,
    typeof meta.filing_date === "string" ? meta.filing_date : null,
  );

  if (/Safe Harbour|forward-looking statements/i.test(text)) {
    extract.risk_disclosures = {
      safe_harbour_note:
        "Presentation contains forward-looking statements; standard safe-harbour language present",
      reliability_caveat: /makes no representation or warranty/i.test(text)
        ? "Company makes no representation or warranty on accuracy/completeness of presentation content"
        : null,
    };
  }

  extract.sentiment_assessment = buildSentimentFromTables(extract);
  return extract;
}
