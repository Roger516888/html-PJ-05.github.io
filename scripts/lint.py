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

errors = []


def err(path, lineno, msg):
    errors.append("%s:%d: %s" % (os.path.basename(path), lineno, msg))


def read_rows(path, expected_cols, header):
    """讀 TSV。回傳 [(lineno, [欄位...])]，不含標題列。"""
    if not os.path.exists(path):
        err(path, 0, "檔案不存在")
        return []

    with io.open(path, encoding="utf-8") as f:
        raw = f.read()

    if not raw.endswith("\n"):
        err(path, 0, "檔尾缺少換行")

    rows = []
    for i, line in enumerate(raw.split("\n"), start=1):
        if line == "":
            continue
        if line.strip() == "":
            err(path, i, "整行空白")
            continue

        fields = line.split("\t")

        # 檢查一：欄位數 / tab 分隔
        if len(fields) != expected_cols:
            if "\t" not in line and " " in line:
                err(path, i, "欄位數 %d（應為 %d）——本行沒有 tab，疑似 tab 在傳輸中被轉成空白"
                    % (len(fields), expected_cols))
            else:
                err(path, i, "欄位數 %d，應為 %d" % (len(fields), expected_cols))
            continue

        if i == 1:
            if fields != header:
                err(path, i, "標題列應為 %s" % "／".join(header))
            continue

        rows.append((i, fields))
    return rows


def check_fields(path, rows, required_idx, names):
    """檢查二：必填欄位不得為空，且不得有前後空白。"""
    for lineno, fields in rows:
        for idx in required_idx:
            v = fields[idx]
            if v == "":
                err(path, lineno, "「%s」欄為空" % names[idx])
            elif v != v.strip():
                err(path, lineno, "「%s」欄有多餘空白" % names[idx])


def main():
    terms = read_rows(TERMS_PATH, len(TERMS_HEADER), TERMS_HEADER)
    rejected = read_rows(REJECTED_PATH, len(REJECTED_HEADER), REJECTED_HEADER)

    # 檢查二：必填欄位（禁語表五欄全必填；排除表三欄全必填）
    check_fields(TERMS_PATH, terms, range(len(TERMS_HEADER)), TERMS_HEADER)
    check_fields(REJECTED_PATH, rejected, range(len(REJECTED_HEADER)), REJECTED_HEADER)

    # 檢查三：重複與交集
    seen = {}
    for lineno, fields in terms:
        t = fields[0]
        if t in seen:
            err(TERMS_PATH, lineno, "禁語「%s」重複（首見於第 %d 行）" % (t, seen[t]))
        else:
            seen[t] = lineno

    seen_rej = {}
    for lineno, fields in rejected:
        t = fields[0]
        if t in seen_rej:
            err(REJECTED_PATH, lineno, "已排除詞「%s」重複（首見於第 %d 行）" % (t, seen_rej[t]))
        else:
            seen_rej[t] = lineno

    for t, lineno in sorted(seen_rej.items(), key=lambda kv: kv[1]):
        if t in seen:
            err(REJECTED_PATH, lineno, "「%s」同時出現在 terms.tsv 第 %d 行" % (t, seen[t]))

    # 檢查四：內容一致性
    for lineno, fields in terms:
        term, suggested, category, basis, _date = fields
        if term == suggested:
            err(TERMS_PATH, lineno, "禁語與建議用語相同：「%s」" % term)
        if category not in CATEGORIES:
            err(TERMS_PATH, lineno, "類別「%s」不在允許清單內" % category)
        for name, v in (("禁語", term), ("建議用語", suggested)):
            if "　" in v:
                err(TERMS_PATH, lineno, "「%s」欄含全形空白" % name)

    if errors:
        sys.stderr.write("lint 失敗，共 %d 項問題：\n" % len(errors))
        for e in errors:
            sys.stderr.write("  %s\n" % e)
        return 1

    print("四項檢查全數通過｜禁語 %d 筆、已排除詞 %d 筆" % (len(terms), len(rejected)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
