#!/usr/bin/env python3
"""
StockScans Industry Extractor
Primary: GET https://www.stockscans.in/api/company/scans/metadata → industryList
Fallback: Selenium dropdown scrape on /concall-scans

Usage: python scripts/stockscans_industry_extractor.py
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

OUT_DIR = Path(__file__).resolve().parent.parent / "data"

try:
    import requests

    REQUESTS_AVAILABLE = True
except ImportError:
    REQUESTS_AVAILABLE = False

try:
    from selenium import webdriver
    from selenium.webdriver.chrome.options import Options
    from selenium.webdriver.chrome.service import Service
    from selenium.webdriver.common.by import By

    SELENIUM_AVAILABLE = True
except ImportError:
    SELENIUM_AVAILABLE = False


class StockScansExtractor:
    def __init__(self, headless: bool = True):
        self.url = "https://www.stockscans.in/concall-scans"
        self.meta_url = "https://www.stockscans.in/api/company/scans/metadata"
        self.headless = headless
        self.industries: list[str] = []

    def extract_via_metadata_api(self) -> bool:
        if not REQUESTS_AVAILABLE:
            print("⚠ requests not installed")
            return False
        print("🔍 Method 1: scans/metadata API")
        print("=" * 50)
        try:
            r = requests.get(
                self.meta_url,
                headers={
                    "User-Agent": "Mozilla/5.0",
                    "Accept": "application/json",
                    "Referer": self.url,
                },
                timeout=30,
            )
            print(f"📍 {self.meta_url} → HTTP {r.status_code}")
            r.raise_for_status()
            data = r.json()
            inds = data.get("industryList") or []
            self.industries = sorted({str(x).strip() for x in inds if str(x).strip()})
            if self.industries:
                print(f"✓ Extracted {len(self.industries)} industries")
                return True
            print("✗ industryList empty")
            return False
        except Exception as e:
            print(f"✗ Error: {e}")
            return False

    def extract_via_selenium(self) -> bool:
        if not SELENIUM_AVAILABLE:
            print("⚠ Selenium not available")
            return False
        print("🔍 Method 2: Selenium WebDriver")
        print("=" * 50)
        options = Options()
        if self.headless:
            options.add_argument("--headless=new")
        options.add_argument("--no-sandbox")
        options.add_argument("--disable-dev-shm-usage")
        try:
            driver = webdriver.Chrome(service=Service(), options=options)
        except Exception as e:
            print(f"✗ Chrome driver error: {e}")
            return False
        try:
            driver.get(self.url)
            time.sleep(3)
            # dismiss common modals
            for sel in [
                "[class*='modal'] button",
                "button[aria-label='Close']",
                "//button[contains(., 'Close') or contains(., 'Skip') or contains(., 'Later')]",
            ]:
                try:
                    els = (
                        driver.find_elements(By.XPATH, sel)
                        if sel.startswith("//")
                        else driver.find_elements(By.CSS_SELECTOR, sel)
                    )
                    for el in els[:3]:
                        if el.is_displayed():
                            el.click()
                            time.sleep(0.5)
                except Exception:
                    pass
            for el in driver.find_elements(By.TAG_NAME, "button"):
                if "Industry" in (el.text or ""):
                    el.click()
                    break
            time.sleep(1.5)
            industries: set[str] = set()
            for sel in [
                "[class*='dropdowns_option']",
                "[class*='option']",
                "li[role='option']",
                "div[role='option']",
            ]:
                for opt in driver.find_elements(By.CSS_SELECTOR, sel):
                    t = (opt.text or "").strip()
                    if t and len(t) > 2:
                        industries.add(t)
            self.industries = sorted(industries)
            if self.industries:
                print(f"✓ Extracted {len(self.industries)} industries")
                return True
            print("✗ No industries extracted")
            return False
        except Exception as e:
            print(f"✗ Error: {e}")
            return False
        finally:
            driver.quit()

    def display_results(self) -> None:
        print("\n" + "=" * 50)
        print(f"EXTRACTED INDUSTRIES ({len(self.industries)} total)")
        print("=" * 50)
        for i, industry in enumerate(self.industries, 1):
            print(f"{i:3d}. {industry}")

    def save_results(self) -> None:
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        (OUT_DIR / "stockscans_industries.txt").write_text(
            "\n".join(self.industries) + "\n", encoding="utf-8"
        )
        (OUT_DIR / "stockscans_industries.json").write_text(
            json.dumps(
                {
                    "industries": self.industries,
                    "total": len(self.industries),
                    "source": self.meta_url,
                },
                indent=2,
                ensure_ascii=False,
            )
            + "\n",
            encoding="utf-8",
        )
        with open(OUT_DIR / "stockscans_industries.csv", "w", encoding="utf-8") as f:
            f.write("Industry\n")
            for ind in self.industries:
                f.write(f'"{ind}"\n')
        print(f"\n✓ Saved under {OUT_DIR}/stockscans_industries.{{txt,json,csv}}")

    def run(self) -> bool:
        print("\n" + "=" * 60)
        print("StockScans Industry List Extractor")
        print("=" * 60)
        if self.extract_via_metadata_api() and self.industries:
            self.display_results()
            self.save_results()
            return True
        if SELENIUM_AVAILABLE and self.extract_via_selenium() and self.industries:
            self.display_results()
            self.save_results()
            return True
        print("\n✗ EXTRACTION FAILED")
        return False


def main() -> None:
    ok = StockScansExtractor(headless=True).run()
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
