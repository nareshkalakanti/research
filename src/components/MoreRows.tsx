"use client";

import { useState } from "react";

/** Long tables render a page at a time (1.5k rows with chips is slow to paint and scroll). */
export function usePagedRows<T>(rows: T[], page = 100): {
  visible: T[];
  more: React.ReactNode;
} {
  const [shown, setShown] = useState(page);
  // New list (filter / sort changed) → back to the first page.
  const [prevRows, setPrevRows] = useState(rows);
  if (prevRows !== rows) {
    setPrevRows(rows);
    setShown(page);
  }
  const visible = rows.length > shown ? rows.slice(0, shown) : rows;
  const more =
    shown < rows.length ? (
      <div className="rot-more">
        <span>
          {shown.toLocaleString()} of {rows.length.toLocaleString()} shown
        </span>
        <button type="button" className="rot-chip" onClick={() => setShown((n) => n + page)}>
          Show {Math.min(page, rows.length - shown)} more
        </button>
        <button type="button" className="rot-chip" onClick={() => setShown(rows.length)}>
          Show all
        </button>
      </div>
    ) : null;
  return { visible, more };
}
