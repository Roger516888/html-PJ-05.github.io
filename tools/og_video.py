#!/usr/bin/env python3
"""og_video.py — 解析貼文頁的 og:video 標籤，取出 mp4 直連。

設計原則：可控、可稽核
  - 只用標準函式庫，零第三方相依（無 requests / bs4 供應鏈風險）
  - 只讀取頁面公開的 Open Graph metadata，不繞過登入、不解 DRM
  - 每次抓取寫一筆 JSONL 稽核紀錄（來源、轉址、HTTP 狀態、HTML 雜湊、所有候選）

用法：
    python3 og_video.py https://example.com/posts/123
    python3 og_video.py URL --json --all
    python3 og_video.py URL --no-robots --audit /var/log/og.jsonl
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import urllib.robotparser
from datetime import datetime, timezone
from html.parser import HTMLParser
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlsplit, urlunsplit
from urllib.request import Request, urlopen

UA = "og-video-parser/1.0 (+stdlib; respects robots.txt)"
TIMEOUT = 15
MAX_BYTES = 2_000_000  # 只讀 HTML 開頭，避免誤抓大檔
DEFAULT_AUDIT = "og_video_audit.jsonl"

# 依可靠度排序：secure_url 通常是 mp4 直連，og:video 有時是 embed 播放頁
WANTED = (
    "og:video:secure_url",
    "og:video:url",
    "og:video",
    "twitter:player:stream",
)


# ---------------------------------------------------------------------------
# 核心：30 行解析器（以下到 extract() 結尾）
# ---------------------------------------------------------------------------
class OGVideoParser(HTMLParser):
    """掃 <meta> 標籤，收集 og:video 系列的 content。"""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.tags: dict[str, str] = {}

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag != "meta":
            return
        a = {k.lower(): (v or "") for k, v in attrs}
        # OG 規範用 property=，部分站台（含 twitter card）用 name=
        key = (a.get("property") or a.get("name") or "").strip().lower()
        val = a.get("content", "").strip()  # HTMLParser 已自動還原 &amp;
        if val and (key in WANTED or key == "og:video:type") and key not in self.tags:
            self.tags[key] = val  # 同名只取第一個，後續重複視為雜訊


def extract(html: str, base_url: str = "") -> tuple[str | None, dict[str, str]]:
    """回傳 (最佳 mp4 直連, 所有候選 tag)。找不到則第一項為 None。"""
    p = OGVideoParser()
    p.feed(html)
    cands = {k: absolutize(v, base_url) for k, v in p.tags.items() if k in WANTED}
    cands = {k: v for k, v in cands.items() if v}  # 濾掉非 http(s) 的來源
    if not cands:
        return None, p.tags
    ranked = sorted(cands.items(), key=lambda kv: (not is_mp4(kv[1]), WANTED.index(kv[0])))
    return ranked[0][1], p.tags


# ---------------------------------------------------------------------------
# 輔助
# ---------------------------------------------------------------------------
def absolutize(url: str, base_url: str) -> str | None:
    """轉絕對網址，並擋掉 javascript: / data: 等非 http(s) scheme。"""
    try:
        full = urljoin(base_url, url.strip()) if base_url else url.strip()
        parts = urlsplit(full)
    except ValueError:
        return None
    if parts.scheme not in ("http", "https") or not parts.netloc:
        return None
    return urlunsplit(parts)


def is_mp4(url: str) -> bool:
    """看路徑副檔名，忽略 query string（?token=... 很常見）。"""
    return urlsplit(url).path.lower().endswith((".mp4", ".m4v"))


def robots_allows(url: str, ua: str = UA, timeout: int = TIMEOUT) -> tuple[bool, str]:
    """檢查 robots.txt。抓不到 robots.txt 時放行，但記錄原因。"""
    parts = urlsplit(url)
    robots_url = urlunsplit((parts.scheme, parts.netloc, "/robots.txt", "", ""))
    rp = urllib.robotparser.RobotFileParser()
    try:
        req = Request(robots_url, headers={"User-Agent": ua})
        with urlopen(req, timeout=timeout) as r:
            rp.parse(r.read(MAX_BYTES).decode("utf-8", "replace").splitlines())
    except (HTTPError, URLError, OSError, ValueError) as e:
        return True, f"robots.txt 無法讀取（{type(e).__name__}），預設放行"
    allowed = rp.can_fetch(ua, url)
    return allowed, "robots.txt 允許" if allowed else "robots.txt 禁止此路徑"


def fetch(url: str, ua: str = UA, timeout: int = TIMEOUT) -> dict:
    """抓取頁面。只讀前 MAX_BYTES bytes，且非 HTML 就拒絕解析。"""
    req = Request(url, headers={"User-Agent": ua, "Accept": "text/html,application/xhtml+xml"})
    with urlopen(req, timeout=timeout) as r:
        ctype = r.headers.get("Content-Type", "")
        raw = r.read(MAX_BYTES)
        charset = r.headers.get_content_charset() or "utf-8"
        final_url, status = r.geturl(), r.status  # 轉址後的真實網址
    if "html" not in ctype.lower() and "xml" not in ctype.lower():
        raise ValueError(f"回應不是 HTML（Content-Type: {ctype or '未提供'}）")
    return {
        "final_url": final_url,
        "status": status,
        "content_type": ctype,
        "bytes": len(raw),
        "sha256": hashlib.sha256(raw).hexdigest(),
        "html": raw.decode(charset, "replace"),
    }


def audit_write(path: str, record: dict) -> None:
    """附加一筆 JSONL 稽核紀錄；寫入失敗不影響主流程。"""
    try:
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
    except OSError as e:
        print(f"[warn] 稽核紀錄寫入失敗 {path}: {e}", file=sys.stderr)


def resolve(url: str, *, check_robots: bool = True, ua: str = UA,
            timeout: int = TIMEOUT) -> dict:
    """完整流程：robots 檢查 → 抓取 → 解析 → 回傳稽核用的結果 dict。"""
    rec: dict = {
        "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "input_url": url,
        "user_agent": ua,
        "ok": False,
        "video_url": None,
        "candidates": {},
        "error": None,
    }
    if not absolutize(url, ""):
        rec["error"] = "輸入網址無效，僅接受 http/https"
        return rec
    if check_robots:
        allowed, why = robots_allows(url, ua, timeout)
        rec["robots"] = why
        if not allowed:
            rec["error"] = f"{why}（如已獲授權可加 --no-robots）"
            return rec
    else:
        rec["robots"] = "略過檢查（--no-robots）"
    try:
        page = fetch(url, ua, timeout)
    except HTTPError as e:
        rec["error"] = f"HTTP {e.code} {e.reason}"
        return rec
    except (URLError, OSError, ValueError) as e:
        rec["error"] = f"{type(e).__name__}: {e}"
        return rec

    html = page.pop("html")
    rec.update(page)
    video_url, tags = extract(html, page["final_url"])
    rec["candidates"] = tags
    rec["video_url"] = video_url
    rec["is_direct_mp4"] = bool(video_url and is_mp4(video_url))
    rec["ok"] = video_url is not None
    if not rec["ok"]:
        rec["error"] = "頁面沒有 og:video 系列標籤（可能是純前端渲染或需登入）"
    return rec


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="解析貼文頁 og:video，取 mp4 直連")
    ap.add_argument("url", help="貼文頁網址")
    ap.add_argument("--json", action="store_true", help="輸出完整 JSON（含稽核欄位）")
    ap.add_argument("--all", action="store_true", help="列出所有候選標籤")
    ap.add_argument("--no-robots", action="store_true", help="略過 robots.txt 檢查")
    ap.add_argument("--audit", default=DEFAULT_AUDIT, help=f"稽核檔路徑（預設 {DEFAULT_AUDIT}）")
    ap.add_argument("--no-audit", action="store_true", help="不寫稽核紀錄")
    ap.add_argument("--timeout", type=int, default=TIMEOUT, help=f"逾時秒數（預設 {TIMEOUT}）")
    ap.add_argument("--user-agent", default=UA, help="自訂 User-Agent")
    args = ap.parse_args(argv)

    rec = resolve(args.url, check_robots=not args.no_robots,
                  ua=args.user_agent, timeout=args.timeout)
    if not args.no_audit:
        audit_write(args.audit, rec)

    if args.json:
        print(json.dumps(rec, ensure_ascii=False, indent=2))
    elif rec["ok"]:
        print(rec["video_url"])
        if args.all:
            for k, v in rec["candidates"].items():
                print(f"  {k}: {v}", file=sys.stderr)
        if not rec["is_direct_mp4"]:
            print("[warn] 這不是 .mp4 結尾，可能是 embed 播放頁", file=sys.stderr)
    else:
        print(f"[error] {rec['error']}", file=sys.stderr)
    return 0 if rec["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
