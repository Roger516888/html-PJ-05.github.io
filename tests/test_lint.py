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
    "質量\t品質\t資訊科技\t待查證\t2026-07-25",
    "土豆\t馬鈴薯\t飲食\t待查證\t2026-07-25",
]

VALID_REJECTED = [
    REJECTED_HEADER,
    "手機\t兩岸通用，非陸語專屬\t2026-07-25",
    "電腦\t兩岸通用，台灣正式用語\t2026-07-25",
]

VERIFICATION_HEADER = "禁語\t建議用語\t來源類型\t查到的詞條\t來源網址\t備註\t查證日期"

VALID_VERIFICATION = [
    VERIFICATION_HEADER,
    "視頻\t影片\t國教院樂詞網\tvideo - 影片\thttps://terms.naer.edu.tw/detail/1/\t\t2026-07-26",
]


class LintTestCase(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="lint-test-")
        os.makedirs(os.path.join(self.dir, "scripts"))
        shutil.copy(LINT, os.path.join(self.dir, "scripts", "lint.py"))
        self.write_terms(VALID_TERMS)
        self.write_rejected(VALID_REJECTED)
        self.write_verification(VALID_VERIFICATION)

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

    def write_verification(self, lines, trailing_newline=True):
        self._write("verification.tsv", lines, trailing_newline)

    def run_lint(self):
        # 明確固定 UTF-8：Windows 預設會以 cp950 解碼子程序輸出，
        # 中文錯誤訊息會整批解碼失敗。
        env = dict(os.environ)
        env["PYTHONIOENCODING"] = "utf-8"
        proc = subprocess.run(
            [sys.executable, os.path.join(self.dir, "scripts", "lint.py")],
            capture_output=True, text=True,
            encoding="utf-8", errors="replace", env=env,
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
        lines[2] = "質量\t品質\t資訊科技\t待查證"
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
        lines[2] = "質量\t 品質\t資訊科技\t待查證\t2026-07-25"
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
        lines = VALID_TERMS + ["手機\t行動電話\t資訊科技\t待查證\t2026-07-25"]
        self.write_terms(lines)
        self.assertFails("rejected.tsv:2", "「手機」同時出現在 terms.tsv 第 5 行")

    # -- 檢查四：一致性 -------------------------------------------------
    def test_term_equals_suggested(self):
        lines = list(VALID_TERMS)
        lines[2] = "品質\t品質\t資訊科技\t待查證\t2026-07-25"
        self.write_terms(lines)
        self.assertFails("terms.tsv:3", "禁語與建議用語相同")

    def test_invalid_category(self):
        lines = list(VALID_TERMS)
        lines[2] = "質量\t品質\t政治\t待查證\t2026-07-25"
        self.write_terms(lines)
        self.assertFails("terms.tsv:3", "類別「政治」不在允許清單內")

    # -- 全形空白：所有欄位、兩個檔案 ------------------------------------
    def test_ideographic_space_in_term(self):
        lines = list(VALID_TERMS)
        lines[2] = "質　量\t品質\t資訊科技\t待查證\t2026-07-25"
        self.write_terms(lines)
        self.assertFails("terms.tsv:3", "「禁語」欄含全形空白")

    def test_ideographic_space_in_basis(self):
        """曾漏檢：全形空白只查禁語與建議用語兩欄。"""
        lines = list(VALID_TERMS)
        lines[2] = "質量\t品質\t資訊科技\t待　查證\t2026-07-25"
        self.write_terms(lines)
        self.assertFails("terms.tsv:3", "「依據」欄含全形空白")

    def test_ideographic_space_in_date(self):
        lines = list(VALID_TERMS)
        lines[2] = "質量\t品質\t資訊科技\t待查證\t2026　07-25"
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


    # -- 依據欄與佐證交叉檢查 -------------------------------------------
    def test_invalid_basis(self):
        lines = list(VALID_TERMS)
        lines[2] = "質量\t品質\t資訊科技\t教育部重編國語辭典\t2026-07-25"
        self.write_terms(lines)
        self.assertFails("terms.tsv:3", "依據「教育部重編國語辭典」不在允許清單內")

    def test_authoritative_basis_without_evidence(self):
        """宣稱查得到來源，就必須在 verification.tsv 留網址。"""
        lines = list(VALID_TERMS)
        lines[2] = "質量\t品質\t資訊科技\t國教院樂詞網\t2026-07-25"
        self.write_terms(lines)
        self.assertFails("terms.tsv:3",
                         "verification.tsv 查無「質量」的佐證網址")

    def test_verification_orphan(self):
        lines = VALID_VERIFICATION + [
            "不存在詞\t替代\t國教院樂詞網\t測試\thttps://example.com\t\t2026-07-26"]
        self.write_verification(lines)
        self.assertFails("verification.tsv:3", "「不存在詞」不在 terms.tsv 內")

    def test_verification_source_type_mismatch(self):
        lines = list(VALID_VERIFICATION)
        lines[1] = ("視頻\t影片\t兩岸用語對照\tvideo - 影片"
                    "\thttps://terms.naer.edu.tw/detail/1/\t\t2026-07-26")
        self.write_verification(lines)
        self.assertFails("verification.tsv:2", "來源類型「兩岸用語對照」與 terms.tsv 的依據「國教院樂詞網」不符")

    def test_verification_note_may_be_empty(self):
        """備註為選填，留空不應報錯。"""
        code, out, err = self.run_lint()
        self.assertEqual(code, 0, err)

    def test_verification_url_required(self):
        lines = list(VALID_VERIFICATION)
        lines[1] = "視頻\t影片\t國教院樂詞網\tvideo - 影片\t\t\t2026-07-26"
        self.write_verification(lines)
        self.assertFails("verification.tsv:2", "「來源網址」欄為空")


    def test_verification_duplicate_row(self):
        """曾漏檢：重複列會覆寫 dictionary，交叉比對形同虛設。"""
        lines = VALID_VERIFICATION + [
            "視頻\t影片\t國教院樂詞網\t假詞條\thttps://example.com/x\t\t2026-07-26"]
        self.write_verification(lines)
        self.assertFails("verification.tsv:3", "「視頻」重複（首見於第 2 行）")

    def test_verification_suggested_mismatch(self):
        """曾漏檢：只比對來源類型，建議用語寫錯不會被發現。"""
        lines = list(VALID_VERIFICATION)
        lines[1] = ("視頻\t完全錯誤的詞\t國教院樂詞網\tvideo - 影片"
                    "\thttps://terms.naer.edu.tw/search/\t\t2026-07-26")
        self.write_verification(lines)
        self.assertFails("verification.tsv:2",
                         "建議用語「完全錯誤的詞」與 terms.tsv 的「影片」不符")

    def _write_url(self, url):
        lines = list(VALID_VERIFICATION)
        lines[1] = ("視頻\t影片\t國教院樂詞網\tvideo - 影片\t%s\t\t2026-07-26"
                    % url)
        self.write_verification(lines)

    def test_verification_url_must_be_https(self):
        """曾漏檢：網址欄位只驗非空，填 not-a-url 也會通過。"""
        self._write_url("not-a-url")
        self.assertFails("verification.tsv:2", "scheme 須為 https")

    def test_verification_url_rejects_http(self):
        self._write_url("http://terms.naer.edu.tw/search/")
        self.assertFails("verification.tsv:2", "scheme 須為 https")

    def test_verification_url_rejects_bare_scheme(self):
        """曾漏檢：前綴檢查會放過只有 scheme 的「https://」。"""
        self._write_url("https://")
        self.assertFails("verification.tsv:2", "缺少主機名稱")

    def test_verification_url_rejects_inner_whitespace(self):
        """曾漏檢：前綴檢查會放過「https://not a url」。"""
        self._write_url("https://not a url")
        self.assertFails("verification.tsv:2", "不得含空白字元")

    def test_verification_url_rejects_non_domain_host(self):
        self._write_url("https://localhost")
        self.assertFails("verification.tsv:2", "不像網域")

    def test_verification_url_accepts_query_form(self):
        """樂詞網佐證採搜尋網址，含 query string 須通過。"""
        self._write_url("https://terms.naer.edu.tw/search/"
                        "?query_term=%E5%BD%B1%E7%89%87&match_type=phrase")
        code, out, err = self.run_lint()
        self.assertEqual(code, 0, err)

    def test_industry_basis_now_requires_evidence(self):
        """「業界慣用」宣稱業界穩定使用，須拿得出佐證；未知應填「待查證」。"""
        lines = list(VALID_TERMS)
        lines[2] = "質量\t品質\t資訊科技\t業界慣用\t2026-07-25"
        self.write_terms(lines)
        self.assertFails("terms.tsv:3",
                         "verification.tsv 查無「質量」的佐證網址")

    def test_pending_basis_needs_no_evidence(self):
        """「待查證」是誠實的未知，不需佐證。"""
        lines = list(VALID_TERMS)
        lines[2] = "質量\t品質\t資訊科技\t待查證\t2026-07-25"
        self.write_terms(lines)
        code, out, err = self.run_lint()
        self.assertEqual(code, 0, err)


if __name__ == "__main__":
    unittest.main()
