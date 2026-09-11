#!/usr/bin/env python3
"""
Extract announcement categories from https://www.ldr.one/announcements

Source API (same as the SPA): GET https://api.lotusdew.in/evoting/announcements/categories
Responses are AES-encrypted; decrypt with the client-side key embedded in their public JS bundle.

Usage: python3 scripts/ldr_announcement_categories.py
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
CATEGORIES_URL = "https://api.lotusdew.in/evoting/announcements/categories"
PAGE_URL = "https://www.ldr.one/announcements"

# Public client AES params from ldr.one frontend bundle (CryptoJS AES-CBC).
_KEY = b"kYp3s6v9y$B&E)H+MbQeThWmZq4t7w!z"
_IV = b"hWmZq3t6w9z$C&F)"


def decrypt_data(cipher_b64: str):
    raw = base64.b64decode(cipher_b64)
    pt = unpad(AES.new(_KEY, AES.MODE_CBC, _IV).decrypt(raw), AES.block_size)
    return json.loads(pt.decode("utf-8"))


def normalize_categories(data) -> list[str]:
    cats: list[str] = []

    def take(item):
        if isinstance(item, str) and item.strip():
            cats.append(item.strip())
        elif isinstance(item, dict):
            for k in ("name", "category", "label", "title", "value"):
                if item.get(k):
                    cats.append(str(item[k]).strip())
                    break

    if isinstance(data, list):
        for item in data:
            take(item)
    elif isinstance(data, dict):
        for key in ("data", "categories", "results", "items", "list"):
            if isinstance(data.get(key), list):
                for item in data[key]:
                    take(item)
                break

    return sorted(
        {
            c
            for c in cats
            if c and c.lower() not in {"all categories", ""}
        }
    )


def group_by_prefix(categories: list[str]) -> dict[str, list[str]]:
    grouped: dict[str, list[str]] = defaultdict(list)
    for cat in categories:
        prefix = cat.split("/")[0].strip() if "/" in cat else cat
        grouped[prefix].append(cat)
    return {k: sorted(v) for k, v in sorted(grouped.items())}


def main() -> int:
    print(f"Fetching {CATEGORIES_URL}...")
    r = requests.get(
        CATEGORIES_URL,
        headers={
            "User-Agent": "Mozilla/5.0",
            "Accept": "application/json",
            "Origin": "https://www.ldr.one",
            "Referer": PAGE_URL,
        },
        timeout=60,
    )
    r.raise_for_status()
    payload = r.json()
    if "encryptedData" not in payload:
        print("✗ Unexpected response (no encryptedData)")
        return 1

    data = decrypt_data(payload["encryptedData"])
    categories = normalize_categories(data)
    grouped = group_by_prefix(categories)
    print(f"✓ Found {len(categories)} categories ({len(grouped)} prefixes)")

    print("\n" + "=" * 60)
    print(f"CATEGORIES ({len(categories)} total)")
    print("=" * 60)
    for prefix, items in grouped.items():
        print(f"\n{prefix}/ ({len(items)})")
        for cat in items[:12]:
            print(f"  - {cat}")
        if len(items) > 12:
            print(f"  ... +{len(items) - 12} more")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out = {
        "timestamp": datetime.now().isoformat(),
        "source": CATEGORIES_URL,
        "page": PAGE_URL,
        "total": len(categories),
        "categories": categories,
        "grouped": grouped,
    }
    (OUT_DIR / "ldr_announcement_categories.json").write_text(
        json.dumps(out, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    (OUT_DIR / "ldr_announcement_categories.txt").write_text(
        "\n".join(categories) + "\n", encoding="utf-8"
    )
    with open(OUT_DIR / "ldr_announcement_categories.csv", "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Category", "Prefix", "Type"])
        for cat in categories:
            prefix = cat.split("/")[0].strip() if "/" in cat else cat
            w.writerow([cat, prefix, "Hierarchical" if "/" in cat else "Simple"])

    top = sorted(grouped.keys(), key=lambda x: len(grouped[x]), reverse=True)[:8]
    print("\n📊 Summary:")
    print(f"   Total categories: {len(categories)}")
    print(f"   Unique prefixes: {len(grouped)}")
    print(f"   Top prefixes: {[(p, len(grouped[p])) for p in top]}")
    print(f"\n✓ Saved under {OUT_DIR}/ldr_announcement_categories.{{json,txt,csv}}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
