import { createHash } from "crypto";
import { load as loadHtml } from "cheerio";
import { openValuepickr, vpMetaSet } from "./valuepickr-db";
import { mapThreadTitle } from "./valuepickr-map";

const VP_ORIGIN = "https://forum.valuepickr.com";
const UA = "research-app valuepickr-ingest/1.0";

type TopicRow = {
  id: number;
  title: string;
  slug: string;
  created_at?: string;
  last_posted_at?: string;
  category_id?: number;
};

function textFromCooked(html: string): string {
  const $ = loadHtml(`<div id="vp-root">${html || ""}</div>`);
  return $("#vp-root").text().replace(/\s+/g, " ").trim();
}

function hashContent(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

async function getJson(path: string): Promise<unknown> {
  const res = await fetch(`${VP_ORIGIN}${path}`, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`ValuePickr HTTP ${res.status} ${path}`);
  return res.json();
}

export async function ingestValuepickr(opts?: {
  pages?: number;
  postsPerTopic?: number;
}): Promise<{
  threads: number;
  posts: number;
  mapped: number;
  unmapped: number;
}> {
  const pages = Math.max(1, Math.min(opts?.pages ?? 4, 8));
  const postsPerTopic = Math.max(5, Math.min(opts?.postsPerTopic ?? 20, 40));
  const db = openValuepickr();
  const cats = new Map<number, string>();
  try {
    const catJson = (await getJson("/categories.json")) as {
      category_list?: { categories?: { id: number; name: string }[] };
    };
    for (const c of catJson.category_list?.categories ?? []) {
      cats.set(c.id, c.name);
    }
  } catch {
    /* categories optional */
  }

  const topics: TopicRow[] = [];
  for (let p = 0; p < pages; p++) {
    const q = p === 0 ? "/latest.json" : `/latest.json?page=${p}`;
    const json = (await getJson(q)) as {
      topic_list?: { topics?: TopicRow[] };
    };
    const rows = json.topic_list?.topics ?? [];
    if (!rows.length) break;
    topics.push(...rows);
  }

  const insThread = db.prepare(`
    INSERT INTO vp_thread(thread_id,title,url,company_id,category,created_at,last_activity_at)
    VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(thread_id) DO UPDATE SET
      title=excluded.title,
      url=excluded.url,
      company_id=excluded.company_id,
      category=excluded.category,
      last_activity_at=excluded.last_activity_at
  `);
  const insPost = db.prepare(`
    INSERT INTO vp_post(post_id,thread_id,author_id,author_name,content,posted_at,post_url,content_hash,company_id)
    VALUES(?,?,?,?,?,?,?,?,?)
    ON CONFLICT(post_id) DO UPDATE SET
      content=excluded.content,
      posted_at=excluded.posted_at,
      content_hash=excluded.content_hash,
      company_id=excluded.company_id
  `);
  const insCo = db.prepare(`
    INSERT INTO vp_company(company_id,company_name,ticker,aliases,mapping_confidence)
    VALUES(?,?,?,?,?)
    ON CONFLICT(company_id) DO UPDATE SET
      company_name=excluded.company_name,
      ticker=excluded.ticker,
      mapping_confidence=excluded.mapping_confidence
  `);
  const insAu = db.prepare(`
    INSERT INTO vp_author(author_id,author_name,first_seen,last_seen)
    VALUES(?,?,?,?)
    ON CONFLICT(author_id) DO UPDATE SET
      author_name=excluded.author_name,
      first_seen=CASE
        WHEN first_seen IS NULL OR excluded.first_seen < first_seen THEN excluded.first_seen
        ELSE first_seen END,
      last_seen=CASE
        WHEN last_seen IS NULL OR excluded.last_seen > last_seen THEN excluded.last_seen
        ELSE last_seen END
  `);
  const seenHash = db.prepare(
    "SELECT post_id FROM vp_post WHERE content_hash = ? AND post_id != ? LIMIT 1",
  );

  let posts = 0;
  let mapped = 0;
  let unmapped = 0;

  for (const t of topics) {
    const threadId = String(t.id);
    const url = `${VP_ORIGIN}/t/${t.slug}/${t.id}`;
    const hit = mapThreadTitle(t.title || "");
    if (hit) {
      mapped += 1;
      insCo.run(
        hit.company_id,
        hit.company_name,
        hit.ticker,
        null,
        hit.mapping_confidence,
      );
    } else {
      unmapped += 1;
    }
    insThread.run(
      threadId,
      t.title || "(untitled)",
      url,
      hit?.company_id ?? null,
      cats.get(t.category_id ?? -1) ?? null,
      t.created_at ?? null,
      t.last_posted_at ?? null,
    );

    let topicJson: {
      post_stream?: {
        posts?: {
          id: number;
          username?: string;
          cooked?: string;
          created_at?: string;
          post_number?: number;
        }[];
      };
      slug?: string;
    };
    try {
      topicJson = (await getJson(`/t/${t.id}.json`)) as typeof topicJson;
    } catch {
      continue;
    }
    const stream = (topicJson.post_stream?.posts ?? []).slice(0, postsPerTopic);
    for (const p of stream) {
      const content = textFromCooked(p.cooked || "");
      if (!content) continue;
      const postId = String(p.id);
      const content_hash = hashContent(content);
      const dup = seenHash.get(content_hash, postId) as { post_id: string } | undefined;
      if (dup) continue;
      const author = (p.username || "unknown").trim();
      const posted = p.created_at || null;
      const postUrl = `${url}/${p.post_number ?? 1}`;
      insPost.run(
        postId,
        threadId,
        author,
        author,
        content,
        posted,
        postUrl,
        content_hash,
        hit?.company_id ?? null,
      );
      insAu.run(author, author, posted, posted);
      posts += 1;
    }
  }

  vpMetaSet(db, "ingested_at", new Date().toISOString());
  db.close();
  return { threads: topics.length, posts, mapped, unmapped };
}
