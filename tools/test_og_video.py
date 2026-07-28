#!/usr/bin/env python3
"""og_video.py 的離線測試（不連網，只驗解析邏輯）。

執行：python3 -m unittest discover -s tools -v
"""

import json
import os
import tempfile
import unittest

from og_video import absolutize, audit_write, extract, is_mp4


def page(*metas: str) -> str:
    return "<!DOCTYPE html><html><head>" + "".join(metas) + "</head><body>貼文</body></html>"


class TestExtract(unittest.TestCase):
    def test_basic_og_video(self):
        url, tags = extract(page('<meta property="og:video" content="https://cdn.test/a.mp4">'))
        self.assertEqual(url, "https://cdn.test/a.mp4")
        self.assertEqual(tags["og:video"], "https://cdn.test/a.mp4")

    def test_secure_url_wins_over_embed_page(self):
        """og:video 是 embed 播放頁時，應挑 secure_url 的 mp4。"""
        url, _ = extract(page(
            '<meta property="og:video" content="https://test/embed/1">',
            '<meta property="og:video:secure_url" content="https://cdn.test/v.mp4">',
        ))
        self.assertEqual(url, "https://cdn.test/v.mp4")

    def test_mp4_beats_tag_priority(self):
        """即使 secure_url 排序較前，非 mp4 也要讓位給真正的 mp4。"""
        url, _ = extract(page(
            '<meta property="og:video:secure_url" content="https://test/player.html">',
            '<meta property="og:video:url" content="https://cdn.test/real.mp4">',
        ))
        self.assertEqual(url, "https://cdn.test/real.mp4")

    def test_name_attribute_and_twitter_fallback(self):
        """部分站台用 name= 而非 property=。"""
        url, _ = extract(page('<meta name="twitter:player:stream" content="https://cdn.test/t.mp4">'))
        self.assertEqual(url, "https://cdn.test/t.mp4")

    def test_html_entities_unescaped(self):
        """&amp; 必須還原，否則簽章 query 會壞掉。"""
        url, _ = extract(page(
            '<meta property="og:video" content="https://cdn.test/v.mp4?sig=a&amp;exp=99">'))
        self.assertEqual(url, "https://cdn.test/v.mp4?sig=a&exp=99")

    def test_relative_url_resolved_against_base(self):
        url, _ = extract(page('<meta property="og:video" content="/media/v.mp4">'),
                         "https://post.test/p/123")
        self.assertEqual(url, "https://post.test/media/v.mp4")

    def test_protocol_relative_url(self):
        url, _ = extract(page('<meta property="og:video" content="//cdn.test/v.mp4">'),
                         "https://post.test/p/123")
        self.assertEqual(url, "https://cdn.test/v.mp4")

    def test_rejects_non_http_scheme(self):
        """javascript:/data: 不得被當成影片來源。"""
        url, _ = extract(page('<meta property="og:video" content="javascript:alert(1)">'))
        self.assertIsNone(url)

    def test_no_tag_returns_none(self):
        url, tags = extract(page('<meta property="og:title" content="無影片">'))
        self.assertIsNone(url)
        self.assertEqual(tags, {})

    def test_duplicate_tags_keep_first(self):
        url, _ = extract(page(
            '<meta property="og:video" content="https://cdn.test/first.mp4">',
            '<meta property="og:video" content="https://cdn.test/second.mp4">',
        ))
        self.assertEqual(url, "https://cdn.test/first.mp4")

    def test_case_insensitive_property(self):
        url, _ = extract(page('<META PROPERTY="OG:VIDEO" CONTENT="https://cdn.test/v.mp4">'))
        self.assertEqual(url, "https://cdn.test/v.mp4")

    def test_malformed_html_does_not_crash(self):
        url, _ = extract('<html><head><meta property="og:video" content="https://cdn.test/v.mp4"'
                         '<body><p>未閉合標籤')
        self.assertEqual(url, "https://cdn.test/v.mp4")

    def test_empty_content_ignored(self):
        url, _ = extract(page(
            '<meta property="og:video:secure_url" content="">',
            '<meta property="og:video" content="https://cdn.test/v.mp4">',
        ))
        self.assertEqual(url, "https://cdn.test/v.mp4")


class TestHelpers(unittest.TestCase):
    def test_is_mp4_ignores_query(self):
        self.assertTrue(is_mp4("https://cdn.test/v.mp4?token=abc&x=1"))
        self.assertTrue(is_mp4("https://cdn.test/v.M4V"))
        self.assertFalse(is_mp4("https://cdn.test/watch?v=mp4"))
        self.assertFalse(is_mp4("https://cdn.test/stream.m3u8"))

    def test_absolutize_guards(self):
        self.assertIsNone(absolutize("data:video/mp4;base64,AAA", ""))
        self.assertIsNone(absolutize("ftp://test/v.mp4", ""))
        self.assertIsNone(absolutize("/v.mp4", ""))  # 無 base 的相對路徑
        self.assertEqual(absolutize("  https://cdn.test/v.mp4  ", ""), "https://cdn.test/v.mp4")

    def test_audit_write_appends_jsonl(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "audit.jsonl")
            audit_write(path, {"input_url": "https://a.test", "ok": True})
            audit_write(path, {"input_url": "https://b.test", "ok": False})
            with open(path, encoding="utf-8") as f:
                rows = [json.loads(line) for line in f]
        self.assertEqual([r["input_url"] for r in rows], ["https://a.test", "https://b.test"])

    def test_audit_write_survives_bad_path(self):
        audit_write("/nonexistent-dir-xyz/audit.jsonl", {"ok": True})  # 不應拋例外


if __name__ == "__main__":
    unittest.main()
