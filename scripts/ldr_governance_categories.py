#!/usr/bin/env python3
"""
Extract e-voting / BoardroomIQ resolution categories from https://www.ldr.one/governance

Primary source (full tag facet used by the SPA filter chips):
  GET https://api.lotusdew.in/evoting/results/summary  (AES-encrypted)

Also merges https://api.lotusdew.in/categories (plaintext subset).

Usage: python3 scripts/ldr_governance_categories.py
"""

from __future__ import annotations

import base64
import csv
import json
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

import requests

try:
    from Crypto.Cipher import AES
    from Crypto.Util.Padding import unpad
except ImportError:
    print("Install: pip install pycryptodome")
    sys.exit(1)

OUT_DIR = Path(__file__).resolve().parent.parent / "data"
SUMMARY_URL = "https://api.lotusdew.in/evoting/results/summary"
CATEGORIES_URL = "https://api.lotusdew.in/categories"
PAGE_URL = "https://www.ldr.one/governance"

# Public client AES params from ldr.one frontend bundle (CryptoJS AES-CBC).
_KEY = b"kYp3s6v9y$B&E)H+MbQeThWmZq4t7w!z"
_IV = b"hWmZq3t6w9z$C&F)"

HEADERS = {
    "User-Agent": "Mozilla/5.0",
    "Accept": "application/json",
    "Origin": "https://www.ldr.one",
    "Referer": PAGE_URL,
}


def decrypt_data(cipher_b64: str):
    raw = base64.b64decode(cipher_b64)
    pt = unpad(AES.new(_KEY, AES.MODE_CBC, _IV).decrypt(raw), AES.block_size)
    return json.loads(pt.decode("utf-8"))


def normalize_tag_list(raw) -> list[str]:
    cats: list[str] = []

    def take(item):
        if isinstance(item, str) and item.strip():
            cats.append(item.strip())
        elif isinstance(item, dict):
            for k in ("name", "category", "label", "title", "value", "tag"):
                if item.get(k):
                    cats.append(str(item[k]).strip())
                    break

    if isinstance(raw, list):
        for item in raw:
            take(item)
    elif isinstance(raw, dict):
        for key in ("tags", "data", "categories", "results", "items", "list"):
            val = raw.get(key)
            if isinstance(val, list):
                for item in val:
                    take(item)
                break
            if isinstance(val, dict) and isinstance(val.get("tags"), list):
                for item in val["tags"]:
                    take(item)
                break

    return sorted(
        {
            c
            for c in cats
            if c and c.lower() not in {"all categories", "all results", ""}
        }
    )


def group_by_prefix(categories: list[str]) -> dict[str, list[str]]:
    grouped: defaultdict[str, list[str]] = defaultdict(list)
    for cat in categories:
        # "Director Appointment" → Director; keep full name as sole entry otherwise
        parts = cat.split()
        prefix = parts[0] if parts else cat
        grouped[prefix].append(cat)
    return {k: sorted(v) for k, v in sorted(grouped.items())}


def fetch_summary_tags() -> tuple[list[str], dict]:
    print(f"Fetching {SUMMARY_URL}...")
    r = requests.get(SUMMARY_URL, headers=HEADERS, timeout=60)
    r.raise_for_status()
    payload = r.json()
    if "encryptedData" not in payload:
        raise RuntimeError("Unexpected summary response (no encryptedData)")
    data = decrypt_data(payload["encryptedData"])
    inner = data.get("data", data) if isinstance(data, dict) else data
    tags = normalize_tag_list(inner if isinstance(inner, dict) else {"tags": inner})
    meta = {}
    if isinstance(inner, dict):
        meta = {
            "total_resolutions": inner.get("total_resolutions"),
            "open_resolutions": inner.get("open_resolutions"),
            "total_tags_reported": inner.get("total_tags"),
        }
    return tags, meta


def fetch_categories_endpoint() -> list[str]:
    print(f"Fetching {CATEGORIES_URL}...")
    r = requests.get(CATEGORIES_URL, headers=HEADERS, timeout=60)
    r.raise_for_status()
    payload = r.json()
    if "encryptedData" in payload:
        data = decrypt_data(payload["encryptedData"])
        return normalize_tag_list(data)
    return normalize_tag_list(payload.get("data", payload))


def main() -> int:
    summary_tags, meta = fetch_summary_tags()
    subset_tags = fetch_categories_endpoint()

    # Prefer the fuller summary facet; union in case /categories has extras.
    categories = sorted(set(summary_tags) | set(subset_tags))
    grouped = group_by_prefix(categories)

    only_summary = sorted(set(summary_tags) - set(subset_tags))
    only_categories = sorted(set(subset_tags) - set(summary_tags))

    print(f"✓ Summary tags: {len(summary_tags)}")
    print(f"✓ /categories tags: {len(subset_tags)}")
    print(f"✓ Union: {len(categories)} ({len(grouped)} prefixes)")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out = {
        "timestamp": datetime.now().isoformat(),
        "source": SUMMARY_URL,
        "sources": [SUMMARY_URL, CATEGORIES_URL],
        "page": PAGE_URL,
        "total": len(categories),
        "meta": meta,
        "categories": categories,
        "grouped": grouped,
        "from_summary_only": only_summary,
        "from_categories_endpoint_only": only_categories,
    }
    json_path = OUT_DIR / "ldr_governance_categories.json"
    json_path.write_text(
        json.dumps(out, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    (OUT_DIR / "ldr_governance_categories.txt").write_text(
        "\n".join(categories) + "\n", encoding="utf-8"
    )
    with open(
        OUT_DIR / "ldr_governance_categories.csv", "w", encoding="utf-8", newline=""
    ) as f:
        w = csv.writer(f)
        w.writerow(["Category", "Prefix"])
        for cat in categories:
            prefix = cat.split()[0] if cat.split() else cat
            w.writerow([cat, prefix])

    print("\n" + "=" * 60)
    print(f"CATEGORIES ({len(categories)} total)")
    print("=" * 60)
    for prefix, items in list(grouped.items())[:12]:
        print(f"\n{prefix} ({len(items)})")
        for cat in items[:8]:
            print(f"  - {cat}")
        if len(items) > 8:
            print(f"  ... +{len(items) - 8} more")

    print("\n📊 Summary:")
    print(f"   Total categories: {len(categories)}")
    print(f"   Unique prefixes: {len(grouped)}")
    if meta:
        print(f"   Resolutions (API): {meta.get('total_resolutions')}")
    print(f"\n✓ Saved under {OUT_DIR}/ldr_governance_categories.{{json,txt,csv}}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
