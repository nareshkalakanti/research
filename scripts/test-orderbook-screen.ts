/**
 * Validate core order fields on golden PDFs.
 *
 *   npm run test:orderbook-screen
 */
import {
  AFCONS_ORDER_SAMPLE_URL,
  COSMIC_CRF_ORDER_SAMPLE_URL,
  DEEPINDS_ORDER_SAMPLE_URL,
  KPEL_ORDER_SAMPLE_URL,
  NOT_DISCLOSED,
  RSL_ORDER_SAMPLE_URL,
  SICALLOG_ORDER_SAMPLE_URL,
  ZENTEC_ORDER_SAMPLE_URL,
  screenOrderbookPdf,
  toCoreOrderFields,
  type OrderbookScreenResult,
} from "../src/lib/orderbook-screen";

type Core = {
  "Awarding entity": string;
  "Order size": string;
  Execution: string;
};

type Case = {
  name: string;
  url: string;
  expect: Core[];
  ticker?: string;
  sizeCr?: number;
};

const CASES: Case[] = [
  {
    name: "AFCONS DRDO",
    url: AFCONS_ORDER_SAMPLE_URL,
    ticker: "AFCONS",
    expect: [
      {
        "Awarding entity": "Defence Research and Development Organisation (DRDO)",
        "Order size": "Rs. 1084.54 Cr (including GST)",
        Execution: "36 Months",
      },
    ],
  },
  {
    name: "RSL captive (2 contracts)",
    url: RSL_ORDER_SAMPLE_URL,
    ticker: "RSL",
    expect: [
      {
        "Awarding entity": "Rajputana Stainless Limited",
        "Order size": "INR 1,621 Lacs + GST per WTG",
        Execution: "11 Months",
      },
      {
        "Awarding entity": "Rajputana Stainless Limited",
        "Order size": "INR 22.71 Crores + GST per WTG",
        Execution: "4 Months",
      },
    ],
  },
  {
    name: "KPEL LOI (MW only)",
    url: KPEL_ORDER_SAMPLE_URL,
    ticker: "KPEL",
    expect: [
      {
        "Awarding entity": "Emmvee Energy Private Limited",
        "Order size": NOT_DISCLOSED,
        Execution: NOT_DISCLOSED,
      },
    ],
  },
  {
    name: "Cosmic CRF (BSE scrip only)",
    url: COSMIC_CRF_ORDER_SAMPLE_URL,
    ticker: "COSMICCRF",
    expect: [
      {
        "Awarding entity": "Infrastructure and Iron & Steel Industry Customer",
        "Order size": "Rs. 651.00 Lakhs",
        Execution: "1 month",
      },
    ],
  },
  {
    name: "DEEPINDS ONGC LOA",
    url: DEEPINDS_ORDER_SAMPLE_URL,
    ticker: "DEEPINDS",
    expect: [
      {
        "Awarding entity": "Oil and Natural Gas Corporation Limited",
        "Order size": "approx. INR 88.15 crores",
        Execution: "Three (03) Years",
      },
    ],
  },
  {
    name: "ZENTEC MoD CTN",
    url: ZENTEC_ORDER_SAMPLE_URL,
    ticker: "ZENTEC",
    expect: [
      {
        "Awarding entity": "Ministry of Defence, Government of India",
        "Order size": "₹ 120 crores (including GST)",
        Execution: "within a year",
      },
    ],
  },
  {
    name: "SICALLOG CCL HEMM",
    url: SICALLOG_ORDER_SAMPLE_URL,
    ticker: "SICALLOG",
    sizeCr: 534.73,
    expect: [
      {
        "Awarding entity": "Central Coalfields Ltd",
        "Order size": "HEMM hire for OB removal + coal extraction, SDOC Mine of Dhori Area",
        Execution: "5 Years (1,825 days)",
      },
    ],
  },
];

function norm(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

function softMatch(got: string, want: string): boolean {
  const g = norm(got).replace(/\blimited\b/g, "ltd").replace(/\bltd\.?\b/g, "ltd");
  const w = norm(want).replace(/\blimited\b/g, "ltd").replace(/\bltd\.?\b/g, "ltd");
  if (g === w) return true;
  if (w !== norm(NOT_DISCLOSED).replace(/\blimited\b/g, "ltd") && (g.includes(w) || w.includes(g))) {
    return true;
  }
  // INR 1,621 Lacs vs INR 1621 Lacs + GST variants
  const gMoney = g.replace(/,/g, "").replace(/\+/g, " ");
  const wMoney = w.replace(/,/g, "").replace(/\+/g, " ");
  if (
    wMoney !== norm(NOT_DISCLOSED) &&
    gMoney.includes(wMoney.replace(/\s+gst.*$/, "").trim())
  ) {
    return true;
  }
  return false;
}

function assertCore(got: Core[], want: Core[], label: string) {
  if (got.length !== want.length) {
    throw new Error(
      `${label}: expected ${want.length} order(s), got ${got.length}: ${JSON.stringify(got)}`,
    );
  }
  for (let i = 0; i < want.length; i++) {
    const g = got[i]!;
    const w = want[i]!;
    for (const key of [
      "Awarding entity",
      "Order size",
      "Execution",
    ] as const) {
      if (!softMatch(g[key], w[key])) {
        throw new Error(
          `${label} #${i + 1} ${key}: got ${JSON.stringify(g[key])} want ${JSON.stringify(w[key])}`,
        );
      }
    }
  }
}

async function runCase(c: Case): Promise<OrderbookScreenResult> {
  console.log("—", c.name);
  const r = await screenOrderbookPdf({ url: c.url });
  const core = r.core?.length ? r.core : toCoreOrderFields(r.extract);
  console.log(JSON.stringify(core, null, 2));
  if (c.ticker) {
    const got = r.extract.ticker?.toUpperCase() || null;
    if (got !== c.ticker.toUpperCase()) {
      throw new Error(
        `${c.name}: ticker got ${JSON.stringify(got)} want ${JSON.stringify(c.ticker)}`,
      );
    }
  }
  if (c.sizeCr != null) {
    const got = r.extract.order_size_cr;
    if (got == null || Math.abs(got - c.sizeCr) > 0.05) {
      throw new Error(
        `${c.name}: sizeCr got ${JSON.stringify(got)} want ${c.sizeCr}`,
      );
    }
  }
  assertCore(core, c.expect, c.name);
  console.log("ok", c.name);
  return r;
}

async function main() {
  for (const c of CASES) {
    await runCase(c);
  }
  console.log("\nAll orderbook golden cases passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
