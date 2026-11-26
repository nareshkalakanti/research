"use client";

/**
 * IPO V2.0 rules: what Davinder Khurana's notes say, how the app reads each rule from
 * saved daily closes and volume, and what is still open. Keep in step with ipo2.ts / lockout.ts.
 */

type Row = {
  rule: string;
  /** Where the rule comes from in the notes / example charts. */
  source: string;
  app: string;
  /** Thresholds the notes don't give: our picks. */
  ours?: string;
};

const BUILT: Row[] = [
  {
    rule: "Urgency",
    source: "“6/8 green weeks · 5–6 green days / 8–9”",
    app: "Green weekly bars in the first 8 weeks after listing (week 1 vs the issue price), green days in sessions 1–9. Urgency when either reaches 6.",
  },
  {
    rule: "Listing-range breakout",
    source: "IREDA: “Urgency in the base, buy here”",
    app: "First close above the range held since listing, within 15 sessions, range at most 15% wide. Stop under the post-listing low.",
    ours: "15 sessions, 15% range",
  },
  {
    rule: "IPO base and later bases",
    source: "Base drawing: “Ideal base size 18–26%”",
    app: "A rest below the high: IPO base 15+ sessions and 5%+ deep (Cyient DLM 7.5%); later bases 25+ sessions, 8%+ deep, after a 25% rise. Failed past 40% (IPO) / 35%.",
    ours: "lengths, 5% / 8% minimum depth, 25% prior rise, failure depths",
  },
  {
    rule: "Low cheat, cheat, pivot",
    source: "Base drawing: low cheat → cheat → pivot base",
    app: "Tight quiet pause in the lower / middle third of the base, entry on a close above it; pivot = close above the base high. Stop under the pause / pivot area, at most 8%.",
    ours: "5-day pause within 6%, volume under 0.8× average",
  },
  {
    rule: "Trendline break",
    source: "Syrma “First entry”, Cyient DLM “First long”",
    app: "First close above a falling line from the base high across at least two lower peaks, before the pivot. Re-arms if its stop is hit.",
    ours: "20 sessions into the base, 2 touches within 1.5%",
  },
  {
    rule: "Expansion legs and adds",
    source: "E1 → E1B → E2 → E2B → E3",
    app: "Each new high after a breakout is a leg; a 5+ session pause 3–12% deep on E1 / E2 gives an add (E1B, E2B). E3 is the leg to sell into.",
    ours: "pause length and depth",
  },
  {
    rule: "Add on the 10/20-day band",
    source: "Jyoti CNC: “E/D” bounce on the band, then “Pyramid – 2nd long, added at 626”",
    app: "Any stock, after a breakout on E1 / E2: a pullback closes into the 10/20-day averages (no more than 3% under the 20-day), then a green close back above the 10-day with the 10-day over the 20-day. One per pullback; stop under the pullback low and the 20-day.",
    ours: "1% band, 3% under the 20-day, 5-session look-back",
  },
  {
    rule: "Strength at listing",
    source: "Waaree: “No selling post listing day in the deteriorated market conditions otherwise”",
    app: "First 20 sessions after listing day vs Nifty 50 on the same dates: 10+ points ahead, never closing 5% under the listing-day close. Says so when Nifty fell over the window. Shown, not scored.",
    ours: "20 sessions, 10 pts, 5% hold, Nifty −2% = weak market",
  },
  {
    rule: "Follow-through days",
    source: "Kaynes: “Buying comes with follow-through days”",
    app: "The 3 sessions after an entry: 2+ green, still above the buy level, volume at least the 50-day average (listing days left out).",
    ours: "3 sessions, 2 green, 1× volume",
  },
  {
    rule: "Base volume",
    source: "“High vols sell off at left side, vols cool down at the bottom, appear again in the right side”",
    app: "Left side vs the quietest week near the low vs the right side, each × the base average; right-side up-day vs down-day volume.",
    ours: "bottom ≤ 0.6× left side, up ÷ down ≥ 1.5× when the right side is quiet",
  },
  {
    rule: "Extension sells",
    source: "Jyoti CNC: sold 1/3 at 535, 1/3 at 625; orange “10%” marks",
    app: "Sell signal after an entry: 1st close 10%+ above its 10-day average, then again on a 2nd extension (after cooling under 5%, or a further 5% leg). No position sizes: how much to sell is your call. Counted per base.",
  },
  {
    rule: "Climax run",
    source: "HIL: “56% up move, 12 green days in a row, highest vols”",
    app: "+25% in 10 sessions with 8+ green days on the highest volume since the entry: sell into strength.",
    ours: "25% / 10 sessions / 8 green",
  },
  {
    rule: "Lockout rallies",
    source: "“Highly concentrated green bars showing range expansion with urgency · 6/8 green weekly bars at the end of stage 1 or start of stage 2”",
    app: "6 of 8 weekly bars green, green weeks 1.5× the base’s usual weekly move, out of a 7+ week sideways base, starting within 10% of the 30-week average.",
    ours: "7-week base, 30% range, 1.5× expansion, 10% band",
  },
];

const QUESTIONS: Row[] = [
  {
    rule: "The red “5%” triangle",
    source: "Jyoti (daily) and EPACK (weekly), at the top of the run",
    app: "Not read. Possibly a 5% extension warning before the 10% mark.",
  },
  {
    rule: "The green “20%” triangle",
    source: "Orient Tech and HIL, at the base low",
    app: "Not read. Possibly a 20%-deep base mark.",
  },
  {
    rule: "Staircase numbers",
    source: "Staircase drawing: legs 12, 12, 8, 3/8 over 18–24 months",
    app: "Not read.",
  },
];

const NEXT: Row[] = [
  {
    rule: "Growth in the initial quarters",
    source: "“High growth sales / earning numbers in the initial quarters”",
    app: "Partly: the Growth check uses the latest quarter (sales and profit ≥ 20% YoY), not the first quarters after listing.",
  },
  {
    rule: "Ignite bar on day 1",
    source: "IREDA “Ignite bar on IPO day”, Jyoti “Respected the high range of ignite bar”",
    app: "Partly possible: day-1 volume and holding above the day-1 close. The day-1 high needs daily highs and lows.",
  },
];

const NEEDS_DATA: Row[] = [
  { rule: "QIB > 25×", source: "IPOs V2.0 slide", app: "Needs IPO subscription figures (shown as “?” on IPO2)." },
  { rule: "Squat, earnings gap-up", source: "Kaynes", app: "Need daily highs and lows, and earnings dates." },
  { rule: "Sell before results", source: "Cyient DLM: “Sold out 2/3rd before earning release”", app: "Needs earnings dates." },
  { rule: "Mount Everest, Staircase patterns", source: "IPOs V2.0 slide", app: "Not defined in the notes beyond the drawing." },
  { rule: "Non-cyclical sectors", source: "IPOs V2.0 slide", app: "Shown, not scored for now (your call)." },
];

function Table({ rows, showOurs }: { rows: Row[]; showOurs?: boolean }) {
  return (
    <div className="vx-table-wrap">
      <table className="vx-table ipo2-rules">
        <thead>
          <tr>
            <th>Rule</th>
            <th>From the notes</th>
            <th>How the app reads it</th>
            {showOurs ? <th>Our numbers (not in the notes)</th> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.rule}>
              <td className="ipo2-rules-name">{r.rule}</td>
              <td className="ipo2-rules-src">{r.source}</td>
              <td>{r.app}</td>
              {showOurs ? <td className="ipo2-rules-ours">{r.ours ?? "—"}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Ipo2RulesPanel() {
  return (
    <section className="vx ipo2-rules-page">
      <header className="vx-head">
        <div>
          <span className="vx-eyebrow">Davinder Khurana · IPOs V2.0, IPO bases, Lockout Rallies</span>
          <h2 className="vx-title">
            IPO V2.0 <span>rules</span>
          </h2>
          <p className="vx-hint">
            IPO2 is short for IPO V2.0. Everything here is read from saved daily closes and volume (no highs, lows or intraday data), so
            “green” means a close above the previous close. Numbers in the last column are the app’s picks where the notes give none.
          </p>
        </div>
      </header>

      <h3 className="ipo2-rules-h">Built ({BUILT.length})</h3>
      <Table rows={BUILT} showOurs />

      <h3 className="ipo2-rules-h">Open questions ({QUESTIONS.length})</h3>
      <Table rows={QUESTIONS} />

      <h3 className="ipo2-rules-h">Could build next ({NEXT.length})</h3>
      <Table rows={NEXT} />

      <h3 className="ipo2-rules-h">Needs data the app doesn’t have ({NEEDS_DATA.length})</h3>
      <Table rows={NEEDS_DATA} />
    </section>
  );
}
