import { openValuepickr, vpMetaGet } from "./valuepickr-db";
import {
  calculateActivitySignal,
  monthlyMentionBars,
  type VpPost,
  type VpSignalRow,
} from "./valuepickr-signal-engine";
import { calculateThemeStrength, tagPostTone } from "./valuepickr-themes";

export type VpCompanyCard = {
  company_id: string;
  company_name: string;
  ticker: string | null;
  mapping_confidence: number | null;
  initials: string;
  why: string;
  row: VpSignalRow;
};

function initials(name: string): string {
  const parts = name
    .replace(/[^A-Za-z0-9 ]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
}

function whyFromThemes(themes: { theme: string; posts: number }[]): string {
  const top = themes.slice(0, 3).map((t) => t.theme.toLowerCase());
  if (!top.length) return "Mapped from ValuePickr thread titles; open evidence for posts.";
  return `${top.join(", ")} appear in qualifying posts.`;
}

export function loadValuepickrBoard(q = ""): {
  as_of: string;
  ingested_at: string | null;
  unmapped_threads: number;
  posts_total: number;
  companies: VpCompanyCard[];
  latest: {
    author: string;
    date: string | null;
    company: string;
    company_id: string | null;
    thread: string;
    excerpt: string;
    url: string;
  }[];
  sources: { name: string; posts: number; avg_signal: number | null }[];
} {
  const db = openValuepickr();
  const asOf = new Date();
  const companies = db
    .prepare(
      `SELECT company_id, company_name, ticker, mapping_confidence FROM vp_company`,
    )
    .all() as {
    company_id: string;
    company_name: string;
    ticker: string | null;
    mapping_confidence: number | null;
  }[];
  const posts = db
    .prepare(
      `SELECT post_id, company_id, author_id, posted_at FROM vp_post WHERE company_id IS NOT NULL`,
    )
    .all() as VpPost[];
  const by = new Map<string, VpPost[]>();
  for (const p of posts) {
    if (!p.company_id) continue;
    const arr = by.get(p.company_id) ?? [];
    arr.push(p);
    by.set(p.company_id, arr);
  }
  const conf = new Map<string, number | null>();
  const nameOf = new Map<string, { name: string; ticker: string | null }>();
  for (const c of companies) {
    conf.set(c.company_id, c.mapping_confidence);
    nameOf.set(c.company_id, { name: c.company_name, ticker: c.ticker });
  }
  const rows = calculateActivitySignal(by, asOf, conf);
  const needle = q.trim().toLowerCase();
  const cards: VpCompanyCard[] = [];
  for (const row of rows) {
    const meta = nameOf.get(row.company_id);
    if (!meta) continue;
    if (
      needle &&
      !meta.name.toLowerCase().includes(needle) &&
      !(meta.ticker || "").toLowerCase().includes(needle) &&
      !row.company_id.toLowerCase().includes(needle)
    ) {
      continue;
    }
    const texts = (
      db
        .prepare(`SELECT content FROM vp_post WHERE company_id = ?`)
        .all(row.company_id) as { content: string }[]
    ).map((r) => r.content);
    const themes = calculateThemeStrength(texts);
    cards.push({
      company_id: row.company_id,
      company_name: meta.name,
      ticker: meta.ticker,
      mapping_confidence: conf.get(row.company_id) ?? null,
      initials: initials(meta.name),
      why: whyFromThemes(themes),
      row,
    });
  }
  cards.sort(
    (a, b) =>
      (b.row.signal ?? -1) - (a.row.signal ?? -1) ||
      b.row.components.mentions_30d - a.row.components.mentions_30d,
  );

  const ingested_at = vpMetaGet(db, "ingested_at");
  const unmapped = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM vp_thread WHERE company_id IS NULL`)
      .get() as { n: number }
  ).n;
  const postsTotal = (
    db.prepare(`SELECT COUNT(*) AS n FROM vp_post`).get() as { n: number }
  ).n;

  const latest = db
    .prepare(
      `SELECT p.author_name AS author, p.posted_at AS date, p.company_id,
              COALESCE(c.company_name, 'UNMAPPED COMPANY') AS company,
              t.title AS thread, p.content AS excerpt, p.post_url AS url
       FROM vp_post p
       JOIN vp_thread t ON t.thread_id = p.thread_id
       LEFT JOIN vp_company c ON c.company_id = p.company_id
       ORDER BY p.posted_at DESC
       LIMIT 40`,
    )
    .all() as {
    author: string;
    date: string | null;
    company: string;
    company_id: string | null;
    thread: string;
    excerpt: string;
    url: string;
  }[];

  const catRows = db
    .prepare(
      `SELECT COALESCE(t.category, 'Uncategorised') AS name, COUNT(*) AS posts
       FROM vp_post p JOIN vp_thread t ON t.thread_id = p.thread_id
       GROUP BY 1 ORDER BY posts DESC LIMIT 8`,
    )
    .all() as { name: string; posts: number }[];

  const sigByCat = new Map<string, number[]>();
  const catCo = db
    .prepare(
      `SELECT COALESCE(t.category, 'Uncategorised') AS name, t.company_id AS cid
       FROM vp_thread t WHERE t.company_id IS NOT NULL`,
    )
    .all() as { name: string; cid: string }[];
  const sigMap = new Map(cards.map((c) => [c.company_id, c.row.signal]));
  for (const r of catCo) {
    const s = sigMap.get(r.cid);
    if (s == null) continue;
    const arr = sigByCat.get(r.name) ?? [];
    arr.push(s);
    sigByCat.set(r.name, arr);
  }

  db.close();
  return {
    as_of: asOf.toISOString(),
    ingested_at,
    unmapped_threads: unmapped,
    posts_total: postsTotal,
    companies: cards,
    latest: latest.map((r) => ({
      ...r,
      excerpt: (r.excerpt || "").slice(0, 240),
    })),
    sources: catRows.map((r) => {
      const arr = sigByCat.get(r.name) ?? [];
      const avg =
        arr.length == 0
          ? null
          : Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
      return { name: r.name, posts: r.posts, avg_signal: avg };
    }),
  };
}

export function loadCompanyEvidence(id: string): {
  company: { company_id: string; company_name: string; ticker: string | null } | null;
  row: VpSignalRow | null;
  posts: {
    author: string;
    date: string | null;
    thread: string;
    excerpt: string;
    url: string;
    themes: string[];
  }[];
  themes: { theme: string; posts: number; pct: number }[];
  months: ReturnType<typeof monthlyMentionBars>;
  unmapped: boolean;
} {
  const db = openValuepickr();
  const co = db
    .prepare(
      `SELECT company_id, company_name, ticker, mapping_confidence FROM vp_company WHERE company_id = ?`,
    )
    .get(id) as
    | {
        company_id: string;
        company_name: string;
        ticker: string | null;
        mapping_confidence: number | null;
      }
    | undefined;
  const postRows = db
    .prepare(
      `SELECT p.post_id, p.company_id, p.author_id, p.author_name, p.posted_at, p.content, p.post_url, t.title
       FROM vp_post p JOIN vp_thread t ON t.thread_id = p.thread_id
       WHERE p.company_id = ?
       ORDER BY p.posted_at DESC`,
    )
    .all(id) as {
    post_id: string;
    company_id: string | null;
    author_id: string;
    author_name: string;
    posted_at: string | null;
    content: string;
    post_url: string;
    title: string;
  }[];
  db.close();
  const asOf = new Date();
  const vpPosts: VpPost[] = postRows.map((p) => ({
    post_id: p.post_id,
    company_id: p.company_id,
    author_id: p.author_id,
    posted_at: p.posted_at,
  }));
  const by = new Map<string, VpPost[]>();
  by.set(id, vpPosts);
  const conf = new Map<string, number | null>();
  conf.set(id, co?.mapping_confidence ?? null);
  const row = calculateActivitySignal(by, asOf, conf)[0] ?? null;
  const themes = calculateThemeStrength(postRows.map((p) => p.content));
  const months = monthlyMentionBars(vpPosts, asOf, (p) => {
    const full = postRows.find((x) => x.post_id === p.post_id);
    return tagPostTone(full?.content || "");
  });
  return {
    company: co
      ? {
          company_id: co.company_id,
          company_name: co.company_name,
          ticker: co.ticker,
        }
      : null,
    row,
    posts: postRows.map((p) => ({
      author: p.author_name,
      date: p.posted_at,
      thread: p.title,
      excerpt: (p.content || "").slice(0, 400),
      url: p.post_url,
      themes: calculateThemeStrength([p.content]).map((t) => t.theme),
    })),
    themes,
    months,
    unmapped: !co,
  };
}
