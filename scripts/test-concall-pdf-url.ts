import assert from "node:assert/strict";
import {
  looksLikeConcallPdfUrl,
  trendlynePdfUrlForPostId,
  trendlynePostIdFromUrl,
  encodeLiteralAmpersandsInPath,
  isPrivatePdfHost,
} from "../src/lib/concall-pdf-url";
import { isConcallPdfProxyUrl } from "../src/lib/concall-screen";

assert.equal(
  trendlynePostIdFromUrl(
    "https://trendlyne.com/posts/1234567/example-company-announcement",
  ),
  "1234567",
);
assert.equal(
  looksLikeConcallPdfUrl(
    "https://trendlyne.com/posts/1234567/example-company-announcement",
  ),
  false,
);
assert.equal(
  looksLikeConcallPdfUrl(trendlynePdfUrlForPostId("1234567")),
  true,
);
const ir =
  "https://ir.example.com/img/investors/financial-results-&-annual-report/q1.pdf";
assert.equal(looksLikeConcallPdfUrl(ir), true);
assert.equal(isConcallPdfProxyUrl(ir), true);
assert.equal(
  encodeLiteralAmpersandsInPath(ir).includes("%26"),
  true,
);
assert.equal(isPrivatePdfHost("127.0.0.1"), true);
assert.equal(isConcallPdfProxyUrl("https://127.0.0.1/secret.pdf"), false);
console.log("ok");
