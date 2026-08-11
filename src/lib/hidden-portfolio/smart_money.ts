/**
 * Smart-money helpers — flag when news hits boutique / HNI / deal keywords.
 */
import type { NewsScanResult } from "./news_scanner";

export function applySmartMoneyFlag(scan: NewsScanResult): {
  smart_money_flag: boolean;
  smart_money_keywords: string[];
  evidence: Array<{ title: string; link: string; matched: string[] }>;
} {
  const evidence = scan.news
    .filter((n) => n.themes.includes("smart_money"))
    .map((n) => ({
      title: n.title,
      link: n.link,
      matched: n.matched.filter((m) =>
        scan.smart_money_keywords.some(
          (k) => k.toLowerCase() === m.toLowerCase(),
        ),
      ),
    }));

  return {
    smart_money_flag: scan.smart_money_flag,
    smart_money_keywords: scan.smart_money_keywords,
    evidence,
  };
}
