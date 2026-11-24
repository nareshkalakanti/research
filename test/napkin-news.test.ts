import assert from "node:assert/strict";
import { parseNews, replyIsCompany } from "../src/lib/napkin/news";

// Parsing: documented field names, newest first, junk and duplicates dropped.
const items = parseNews({
  recentNews: [
    { headline: "Older story", url: "https://example.com/a", date: "2026-10-01T10:00:00Z", intro: "First." },
    { headline: "Newer story", url: "https://example.com/b", date: "2026-11-20T10:00:00Z" },
    { headline: "Newer story", url: "https://example.com/b2", date: "2026-11-20T10:00:00Z" },
    { title: "No link", link: "not-a-url", publishedAt: "2026-11-01" },
    { intro: "no headline" },
    "junk",
  ],
});
assert.deepEqual(items.map((i) => i.title), ["Newer story", "No link", "Older story"]);
assert.equal(items.find((i) => i.title === "No link")!.url, null);
assert.equal(items.find((i) => i.title === "Older story")!.summary, "First.");
assert.deepEqual(parseNews(null), []);

// Identity: the sister company must be rejected.
assert.equal(
  replyIsCompany({ companyName: "Waaree Energies Ltd", companyProfile: { exchangeCodeNse: "WAAREEENER" } }, "WAAREE", "Waaree Technologies Limited").ok,
  false,
);
assert.equal(replyIsCompany({ companyName: "Rajesh Exports Ltd" }, "RAJESH", "Rajesh Power Services Limited").ok, false);
// Same NSE symbol or a close name: accepted.
assert.equal(replyIsCompany({ companyName: "X", companyProfile: { exchangeCodeNse: "TCS" } }, "TCS", "Tata Consultancy Services").ok, true);
assert.equal(replyIsCompany({ companyName: "Rajesh Power Services Ltd" }, "RAJESH", "Rajesh Power Services Limited").ok, true);

console.log("ok");
