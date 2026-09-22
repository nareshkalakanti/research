/** Client-safe URL helpers for concall PDF vs HTML listing pages. */

export function trendlynePostIdFromUrl(url: string): string | null {
  const m =
    url.match(/trendlyne\.com\/posts\/(\d+)/i) ||
    url.match(/get-document\/post\/pdf\/(\d+)/i);
  return m?.[1] || null;
}

export function trendlynePdfUrlForPostId(postId: string): string {
  return `https://trendlyne.com/get-document/post/pdf/${postId.replace(/\D/g, "")}/`;
}

export function looksLikeConcallPdfUrl(url: string): boolean {
  const u = (url || "").trim();
  if (!u) return false;
  if (/^(sample|local):/i.test(u)) return true;
  if (/\.pdf(?:[?#]|$)/i.test(u)) return true;
  if (/get-document\/post\/pdf/i.test(u)) return true;
  if (/AnnPdfOpen|AttachHis|AttachLive|nsearchives/i.test(u)) return true;
  return false;
}

export function isPrivatePdfHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/\.+$/, "");
  if (!h || h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) {
    return true;
  }
  if (h === "::1" || h.startsWith("[") || h === "0.0.0.0") return true;
  if (
    /^(127|10)\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h) ||
    /^192\.168\.\d{1,3}\.\d{1,3}$/.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(h) ||
    /^169\.254\.\d{1,3}\.\d{1,3}$/.test(h)
  ) {
    return true;
  }
  return false;
}

/** IR paths often contain a literal & (financial-results-&-annual-report). */
export function encodeLiteralAmpersandsInPath(url: string): string {
  try {
    const u = new URL(url);
    if (!u.pathname.includes("&")) return url;
    u.pathname = u.pathname.replace(/&/g, "%26");
    return u.toString();
  } catch {
    return url;
  }
}
