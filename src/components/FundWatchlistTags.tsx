"use client";

import {
  FUND_WATCHLIST_KEYS,
  FUND_WATCHLIST_LABELS,
  fundChangeBadge,
  fundChangeClass,
  type FundChangeInfo,
  type FundWatchlistKey,
} from "@/lib/fund-watchlist-meta";

type TagClass = "result-tag" | "gov-tag" | "ag-tag";

type Props = {
  tags: FundWatchlistKey[] | undefined;
  changes?: Partial<Record<FundWatchlistKey, FundChangeInfo>>;
  tagClass?: TagClass;
  /** Skip tags not in this allowlist (e.g. governance focus bar). */
  only?: FundWatchlistKey[];
};

export function FundWatchlistTags({
  tags,
  changes,
  tagClass = "result-tag",
  only,
}: Props) {
  if (!tags?.length) return null;
  const allowed = only ? new Set(only) : null;
  const cls =
    tagClass === "result-tag"
      ? "result-tag"
      : tagClass === "gov-tag"
        ? "gov-tag"
        : tagClass === "ag-tag"
          ? "ag-tag"
          : tagClass;
  return (
    <>
      {tags.map((key) => {
        if (allowed && !allowed.has(key)) return null;
        const label = FUND_WATCHLIST_LABELS[key];
        const keyCls =
          tagClass === "gov-tag"
            ? `gov-tag-${key}`
            : tagClass === "ag-tag"
              ? `ag-tag-${key}`
              : `tag-${key}`;
        const chg = changes?.[key];
        const badge = fundChangeBadge(chg);
        return (
          <span
            key={key}
            className={`fund-tag-wrap${badge ? " has-chg" : ""}`}
            title={
              badge
                ? `${label} — ${badge === "new" ? "new position" : badge}`
                : `${label} fund watchlist`
            }
          >
            <span className={`${cls} ${keyCls}`}>{label}</span>
            {badge ? (
              <span className={fundChangeClass(chg?.change_type)}>{badge}</span>
            ) : null}
          </span>
        );
      })}
    </>
  );
}

/** True if company row has any fund tag (legacy has_* fields or fund_tags). */
export function companyFundTags(company: {
  fund_tags?: FundWatchlistKey[];
  has_niveshaay?: boolean;
  has_negen?: boolean;
  has_kacholia?: boolean;
  has_mukul?: boolean;
  has_kedia?: boolean;
  has_singhania?: boolean;
  has_kela?: boolean;
}): FundWatchlistKey[] {
  if (company.fund_tags?.length) return company.fund_tags;
  return FUND_WATCHLIST_KEYS.filter((k) => {
    const flag = company[`has_${k}` as keyof typeof company];
    return flag === true;
  });
}
