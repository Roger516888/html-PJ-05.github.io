#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""scripts/lint.py 的回歸測試。

每個測項先寫出一份 fixture，再跑 lint，斷言它**擋下來**並指到正確行號。
目的是防止日後修改 lint 時把檢查改鬆而沒人發現。
"""
import io
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LINT = os.path.join(ROOT, "scripts", "lint.py")

TERMS_HEADER = "禁語\t建議用語\t類別\t依據\t收錄日期"
REJECTED_HEADER = "詞\t不收錄原因\t判定日期"

VALID_TERMS = [
    TERMS_HEADER,
    "視頻\t影片\t資訊科技\t國教院樂詞網\t2026-07-25",
    "質量\t品質\t資訊科技\t教育部重編國語辭典\t2026-07-25",
    "土豆\t馬鈴薯\t飲食\t教育部重編國語辭典\t2026-07-25",
]

VALID_REJECTED = [
    REJECTED_HEADER,
    "手機\t兩岸通用，非陸語專屬\t2026-07-25",
    "電腦\t兩岸通用，台灣正式用語\t2026-07-25",
]


class LintTestCase(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="lint-test-")
        os.makedirs(os.path.join(self.dir, "scripts"))
        shutil.copy(LINT, os.path.join(self.dir, "scripts", "lint.py"))
        self.write_terms(VALID_TERMS)
        self.write_rejected(VALID_REJECTED)

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    # -- helpers -------------------------------------------------------
    def _write(self, name, lines, trailing_newline=True):
        path = os.path.join(self.dir, name)
        text = "\n".join(lines)
        if trailing_newline:
            text += "\n"
        with io.open(path, "w", encoding="utf-8", newline="") as f:
            f.write(text)

    def write_terms(self, lines, trailing_newline=True):
        self._write("terms.tsv", lines, trailing_newline)

    def write_rejected(self, lines, trailing_newline=True):
        self._write("rejected.tsv", lines, trailing_newline)

    def run_lint(self):
        proc = subprocess.run(
            [sys.executable, os.path.join(self.dir, "scripts", "lint.py")],
            capture_output=True, text=True,
        )
        return proc.returncode, proc.stdout, proc.stderr

    def assertFails(self, *fragments):
        code, out, err = self.run_lint()
        self.assertEqual(code, 1, "lint 應失敗，實際 exit 0；stdout=%r" % out)
        for frag in fragments:
            self.assertIn(frag, err, "錯誤訊息缺少 %r，實際：\n%s" % (frag, err))
        return err

    # -- 合法 fixture 必須通過 -----------------------------------------
    def test_valid_fixture_passes(self):
        code, out, err = self.run_lint()
        self.assertEqual(code, 0, "合法 fixture 應通過，stderr=\n%s" % err)
        self.assertIn("四項檢查全數通過｜禁語 3 筆、已排除詞 2 筆", out)

    # -- 檢查一：格式 ---------------------------------------------------
    def test_tab_converted_to_spaces(self):
        lines = list(VALID_TERMS)
        lines[2] = lines[2].replace("\t", "    ")
        self.write_terms(lines)
        self.assertFails("terms.tsv:3", "疑似 tab 在傳輸中被轉成空白")

    def test_wrong_field_count(self):
        lines = list(VALID_TERMS)
        lines[2] = "質量\t品質\t資訊科技\t教育部重編國語辭典"
        self.write_terms(lines)
        self.assertFails("terms.tsv:3", "欄位數 4，應為 5")

    def test_bad_header(self):
        lines = list(VALID_TERMS)
        lines[0] = "詞\t建議\t類別\t依據\t日期"
        self.write_terms(lines)
        self.assertFails("terms.tsv:1", "標題列應為")

    def test_missing_trailing_newline(self):
        self.write_terms(VALID_TERMS, trailing_newline=False)
        self.assertFails("檔尾缺少換行")

    def test_blank_line_in_middle(self):
        """曾漏檢：檔案中間的真正空行被當成檔尾空元素跳過。"""
        lines = VALID_TERMS[:2] + [""] + VALID_TERMS[2:]
        self.write_terms(lines)
        self.assertFails("terms.tsv:3", "空白行")

    def test_whitespace_only_line_in_middle(self):
        lines = VALID_TERMS[:2] + ["   "] + VALID_TERMS[2:]
        self.write_terms(lines)
        self.assertFails("terms.tsv:3", "空白行")

    # -- 檢查二：必填 ---------------------------------------------------
    def test_empty_field(self):
        lines = list(VALID_TERMS)
        lines[2] = "質量\t品質\t資訊科技\t\t2026-07-25"
        self.write_terms(lines)
        self.assertFails("terms.tsv:3", "「依據」欄為空")

    def test_surrounding_whitespace(self):
        lines = list(VALID_TERMS)
        lines[2] = "質量\t 品質\t資訊科技\t教育部重編國語辭典\t2026-07-25"
        self.write_terms(lines)
        self.assertFails("terms.tsv:3", "「建議用語」欄有多餘空白")

    def test_empty_field_in_rejected(self):
        lines = list(VALID_REJECTED)
        lines[1] = "手機\t\t2026-07-25"
        self.write_rejected(lines)
        self.assertFails("rejected.tsv:2", "「不收錄原因」欄為空")

    # -- 檢查三：重複與交集 ---------------------------------------------
    def test_duplicate_term(self):
        lines = VALID_TERMS + ["視頻\t影片\t資訊科技\t國教院樂詞網\t2026-07-25"]
        self.write_terms(lines)
        self.assertFails("terms.tsv:5", "禁語「視頻」重複（首見於第 2 行）")

    def test_duplicate_rejected(self):
        lines = VALID_REJECTED + ["手機\t兩岸通用\t2026-07-25"]
        self.write_rejected(lines)
        self.assertFails("rejected.tsv:4", "已排除詞「手機」重複（首見於第 2 行）")

    def test_cross_file_overlap(self):
        lines = VALID_TERMS + ["手機\t行動電話\t資訊科技\t業界慣用\t2026-07-25"]
        self.write_terms(lines)
        self.assertFails("rejected.tsv:2", "「手機」同時出現在 terms.tsv 第 5 行")

    # -- 檢查四：一致性 -------------------------------------------------
    def test_term_equals_suggested(self):
        lines = list(VALID_TERMS)
        lines[2] = "品質\t品質\t資訊科技\t教育部重編國語辭典\t2026-07-25"
        self.write_terms(lines)
        self.assertFails("terms.tsv:3", "禁語與建議用語相同")

    def test_invalid_category(self):
        lines = list(VALID_TERMS)
        lines[2] = "質量\t品質\t政治\t教育部重編國語辭典\t2026-07-25"
        self.write_terms(lines)
        self.assertFails("terms.tsv:3", "類別「政治」不在允許清單內")

    # -- 全形空白：所有欄位、兩個檔案 ------------------------------------
    def test_ideographic_space_in_term(self):
        lines = list(VALID_TERMS)
        lines[2] = "質　量\t品質\t資訊科技\t教育部重編國語辭典\t2026-07-25"
        self.write_terms(lines)
        self.assertFails("terms.tsv:3", "「禁語」欄含全形空白")

    def test_ideographic_space_in_basis(self):
        """曾漏檢：全形空白只查禁語與建議用語兩欄。"""
        lines = list(VALID_TERMS)
        lines[2] = "質量\t品質\t資訊科技\t教育部　重編國語辭典\t2026-07-25"
        self.write_terms(lines)
        self.assertFails("terms.tsv:3", "「依據」欄含全形空白")

    def test_ideographic_space_in_date(self):
        lines = list(VALID_TERMS)
        lines[2] = "質量\t品質\t資訊科技\t教育部重編國語辭典\t2026　07-25"
        self.write_terms(lines)
        self.assertFails("terms.tsv:3", "「收錄日期」欄含全形空白")

    def test_ideographic_space_in_rejected_reason(self):
        """曾漏檢：rejected.tsv 完全未做全形空白檢查。"""
        lines = list(VALID_REJECTED)
        lines[1] = "手機\t兩岸　通用\t2026-07-25"
        self.write_rejected(lines)
        self.assertFails("rejected.tsv:2", "「不收錄原因」欄含全形空白")

    # -- 多項錯誤同時累積 -----------------------------------------------
    def test_multiple_errors_accumulate(self):
        lines = list(VALID_TERMS)
        lines[2] = "質量\t品質\t政治\t\t2026-07-25"
        lines.append("視頻\t影片\t資訊科技\t國教院樂詞網\t2026-07-25")
        self.write_terms(lines)
        err = self.assertFails(
            "terms.tsv:3", "「依據」欄為空",
            "類別「政治」不在允許清單內",
            "terms.tsv:5", "禁語「視頻」重複",
        )
        self.assertIn("lint 失敗，共 3 項問題", err)


if __name__ == "__main__":
    unittest.main()
