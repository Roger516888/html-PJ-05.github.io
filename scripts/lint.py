#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""中文禁語庫 lint：四項檢查。

檢查失敗一律 exit 1，並印出檔名與行號。
lint 擋下來就是資料要改，不要放寬這裡的規則。
"""
import io
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TERMS_PATH = os.path.join(ROOT, "terms.tsv")
REJECTED_PATH = os.path.join(ROOT, "rejected.tsv")

TERMS_HEADER = ["禁語", "建議用語", "類別", "依據", "收錄日期"]
REJECTED_HEADER = ["詞", "不收錄原因", "判定日期"]

CATEGORIES = {
    "資訊科技",
    "網路社群",
    "飲食",
    "交通",
    "商業管理",
    "公共事務",
    "醫療",
    "日常生活",
}

IDEOGRAPHIC_SPACE = "　"


class Linter(object):
    def __init__(self):
        self.errors = []

    def err(self, path, lineno, msg):
        self.errors.append("%s:%d: %s" % (os.path.basename(path), lineno, msg))

    # ------------------------------------------------------------------
    # 檢查一：格式（tab 分隔、欄位數、標題列、檔尾換行、無空白行）
    # ------------------------------------------------------------------
    def read_rows(self, path, header):
        """讀 TSV。回傳 [(lineno, [欄位...])]，不含標題列。"""
        expected = len(header)
        if not os.path.exists(path):
            self.err(path, 0, "檔案不存在")
            return []

        with io.open(path, encoding="utf-8") as f:
            raw = f.read()

        if raw == "":
            self.err(path, 0, "檔案為空")
            return []

        if not raw.endswith("\n"):
            self.err(path, 0, "檔尾缺少換行")

        lines = raw.split("\n")
        # 檔尾換行會在 split 後產生一個空字串，那是正常的，去掉它。
        # 其餘任何空行都是資料問題，不得放過。
        if lines and lines[-1] == "":
            lines.pop()

        rows = []
        for i, line in enumerate(lines, start=1):
            if line.strip() == "":
                self.err(path, i, "空白行")
                continue

            fields = line.split("\t")

            if len(fields) != expected:
                if "\t" not in line and " " in line:
                    self.err(path, i,
                             "欄位數 %d（應為 %d）——本行沒有 tab，"
                             "疑似 tab 在傳輸中被轉成空白"
                             % (len(fields), expected))
                else:
                    self.err(path, i,
                             "欄位數 %d，應為 %d" % (len(fields), expected))
                continue

            if i == 1:
                if fields != header:
                    self.err(path, i, "標題列應為 %s" % "／".join(header))
                continue

            rows.append((i, fields))
        return rows

    # ------------------------------------------------------------------
    # 檢查二：必填（不得為空、不得有前後空白）
    # 檢查四（部分）：所有欄位皆不得含全形空白
    # ------------------------------------------------------------------
    def check_fields(self, path, rows, header):
        for lineno, fields in rows:
            for idx, name in enumerate(header):
                v = fields[idx]
                if v == "":
                    self.err(path, lineno, "「%s」欄為空" % name)
                    continue
                if v != v.strip():
                    self.err(path, lineno, "「%s」欄有多餘空白" % name)
                if IDEOGRAPHIC_SPACE in v:
                    self.err(path, lineno, "「%s」欄含全形空白" % name)

    # ------------------------------------------------------------------
    # 檢查三：重複與交集
    # ------------------------------------------------------------------
    def check_duplicates(self, path, rows, label):
        seen = {}
        for lineno, fields in rows:
            t = fields[0]
            if t in seen:
                self.err(path, lineno,
                         "%s「%s」重複（首見於第 %d 行）" % (label, t, seen[t]))
            else:
                seen[t] = lineno
        return seen

    # ------------------------------------------------------------------
    # 檢查四：內容一致性
    # ------------------------------------------------------------------
    def check_consistency(self, path, rows):
        for lineno, fields in rows:
            term, suggested, category = fields[0], fields[1], fields[2]
            if term == suggested:
                self.err(path, lineno, "禁語與建議用語相同：「%s」" % term)
            if category not in CATEGORIES:
                self.err(path, lineno, "類別「%s」不在允許清單內" % category)

    # ------------------------------------------------------------------
    def run(self):
        terms = self.read_rows(TERMS_PATH, TERMS_HEADER)
        rejected = self.read_rows(REJECTED_PATH, REJECTED_HEADER)

        self.check_fields(TERMS_PATH, terms, TERMS_HEADER)
        self.check_fields(REJECTED_PATH, rejected, REJECTED_HEADER)

        seen_terms = self.check_duplicates(TERMS_PATH, terms, "禁語")
        seen_rej = self.check_duplicates(REJECTED_PATH, rejected, "已排除詞")

        for t, lineno in sorted(seen_rej.items(), key=lambda kv: kv[1]):
            if t in seen_terms:
                self.err(REJECTED_PATH, lineno,
                         "「%s」同時出現在 terms.tsv 第 %d 行" % (t, seen_terms[t]))

        self.check_consistency(TERMS_PATH, terms)

        return terms, rejected


def main():
    linter = Linter()
    terms, rejected = linter.run()

    if linter.errors:
        sys.stderr.write("lint 失敗，共 %d 項問題：\n" % len(linter.errors))
        for e in linter.errors:
            sys.stderr.write("  %s\n" % e)
        return 1

    print("四項檢查全數通過｜禁語 %d 筆、已排除詞 %d 筆"
          % (len(terms), len(rejected)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
