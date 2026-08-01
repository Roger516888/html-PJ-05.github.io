#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""私人禁語詞庫的格式與操作回歸測試。"""

import os
import shutil
import subprocess
import sys
import tempfile
import unittest


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TERMS_SCRIPT = os.path.join(ROOT, "scripts", "terms.py")
LINT_SCRIPT = os.path.join(ROOT, "scripts", "lint.py")
HEADER = "禁語\t替代用語"
VALID_ROWS = [
    HEADER,
    "視頻\t影片",
    "絕絕子\t-",
]


class TermsTestCase(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.mkdtemp(prefix="terms-test-")
        self.path = os.path.join(self.directory, "terms.tsv")
        self.write_rows(VALID_ROWS)
        self.environment = dict(os.environ)
        self.environment["TERMS_FILE"] = self.path
        self.environment["PYTHONIOENCODING"] = "utf-8"

    def tearDown(self):
        shutil.rmtree(self.directory, ignore_errors=True)

    def write_rows(self, rows, trailing_newline=True):
        text = "\n".join(rows)
        if trailing_newline:
            text += "\n"
        with open(self.path, "w", encoding="utf-8", newline="") as handle:
            handle.write(text)

    def run_script(self, script, *arguments):
        return subprocess.run(
            [sys.executable, script, *arguments],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="strict",
            env=self.environment,
        )

    def run_terms(self, *arguments):
        return self.run_script(TERMS_SCRIPT, *arguments)

    def run_lint(self):
        return self.run_script(LINT_SCRIPT)

    def test_valid_file_passes_lint(self):
        result = self.run_lint()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("詞庫檢查通過｜禁語 2 筆", result.stdout)

    def test_bad_header_fails(self):
        self.write_rows(["詞\t替代", *VALID_ROWS[1:]])
        result = self.run_lint()
        self.assertEqual(result.returncode, 1)
        self.assertIn("標題列應為", result.stderr)

    def test_wrong_field_count_fails(self):
        self.write_rows([HEADER, "視頻 影片"])
        result = self.run_lint()
        self.assertEqual(result.returncode, 1)
        self.assertIn("分隔符可能已被轉成空白", result.stderr)

    def test_missing_trailing_newline_fails(self):
        self.write_rows(VALID_ROWS, trailing_newline=False)
        result = self.run_lint()
        self.assertEqual(result.returncode, 1)
        self.assertIn("檔尾缺少換行", result.stderr)

    def test_crlf_fails(self):
        with open(self.path, "w", encoding="utf-8", newline="") as handle:
            handle.write("\r\n".join(VALID_ROWS) + "\r\n")
        result = self.run_lint()
        self.assertEqual(result.returncode, 1)
        self.assertIn("不得含 CR", result.stderr)

    def test_blank_line_fails(self):
        self.write_rows([HEADER, VALID_ROWS[1], "", VALID_ROWS[2]])
        result = self.run_lint()
        self.assertEqual(result.returncode, 1)
        self.assertIn("空白行", result.stderr)

    def test_empty_term_fails(self):
        self.write_rows([HEADER, "\t影片"])
        result = self.run_lint()
        self.assertEqual(result.returncode, 1)
        self.assertIn("「禁語」欄為空", result.stderr)

    def test_empty_optional_field_uses_sentinel(self):
        self.write_rows([HEADER, "視頻\t"])
        result = self.run_lint()
        self.assertEqual(result.returncode, 1)
        self.assertIn("未指定時請填 -", result.stderr)

    def test_duplicate_term_fails(self):
        self.write_rows([*VALID_ROWS, "視頻\t視訊"])
        result = self.run_lint()
        self.assertEqual(result.returncode, 1)
        self.assertIn("禁語「視頻」重複", result.stderr)

    def test_surrounding_whitespace_fails(self):
        self.write_rows([HEADER, " 視頻\t影片"])
        result = self.run_lint()
        self.assertEqual(result.returncode, 1)
        self.assertIn("「禁語」欄有多餘空白", result.stderr)

    def test_add_without_optional_fields(self):
        result = self.run_terms("add", "內卷")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("已新增｜內卷｜目前 3 筆", result.stdout)
        query = self.run_terms("query", "內卷")
        self.assertIn("替代：（未指定）", query.stdout)

    def test_add_with_replacement(self):
        result = self.run_terms("add", "內卷", "--replacement", "過度競爭")
        self.assertEqual(result.returncode, 0, result.stderr)
        query = self.run_terms("query", "內卷")
        self.assertIn("替代：過度競爭", query.stdout)

    def test_duplicate_add_is_rejected(self):
        result = self.run_terms("add", "視頻")
        self.assertEqual(result.returncode, 1)
        self.assertIn("已在詞庫中", result.stderr)

    def test_remove(self):
        result = self.run_terms("remove", "視頻")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("目前 1 筆", result.stdout)
        query = self.run_terms("query", "視頻")
        self.assertEqual(query.returncode, 1)
        self.assertIn("未收錄｜視頻", query.stdout)

    def test_remove_missing_is_rejected(self):
        result = self.run_terms("remove", "不存在")
        self.assertEqual(result.returncode, 1)
        self.assertIn("詞庫中沒有", result.stderr)

    def test_batch_query(self):
        result = self.run_terms("query", "視頻", "不存在", "絕絕子")
        self.assertEqual(result.returncode, 1)
        self.assertIn("已收錄｜視頻", result.stdout)
        self.assertIn("未收錄｜不存在", result.stdout)
        self.assertIn("已收錄｜絕絕子", result.stdout)

    def test_list(self):
        result = self.run_terms("list")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("詞庫共 2 筆", result.stdout)
        self.assertIn("已收錄｜視頻", result.stdout)
        self.assertIn("已收錄｜絕絕子", result.stdout)


if __name__ == "__main__":
    unittest.main()
