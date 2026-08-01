#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""私人禁語詞庫的新增、刪除與批次查詢工具。"""

import argparse
import os
import sys
import tempfile
from dataclasses import dataclass


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_TERMS_PATH = os.path.join(ROOT, "terms.tsv")
TERMS_PATH = os.environ.get("TERMS_FILE", DEFAULT_TERMS_PATH)
HEADER = ("禁語", "替代用語")
EMPTY = "-"


@dataclass(frozen=True)
class Entry:
    term: str
    replacement: str = ""


class TermsFileError(Exception):
    def __init__(self, errors):
        super().__init__("\n".join(errors))
        self.errors = errors


def _error(path, line, message):
    return "%s:%d: %s" % (os.path.basename(path), line, message)


def inspect_terms(path=TERMS_PATH):
    """讀取並檢查詞庫，回傳 ``(entries, errors)``。"""
    errors = []
    entries = []

    if not os.path.exists(path):
        return entries, [_error(path, 0, "檔案不存在")]

    try:
        with open(path, "r", encoding="utf-8", newline="") as handle:
            raw = handle.read()
    except UnicodeDecodeError as exc:
        return entries, [_error(path, 0, "不是有效的 UTF-8（%s）" % exc)]

    if raw == "":
        return entries, [_error(path, 0, "檔案為空")]
    if "\r" in raw:
        errors.append(_error(path, 0, "須使用 LF 換行，不得含 CR"))
    if not raw.endswith("\n"):
        errors.append(_error(path, 0, "檔尾缺少換行"))

    lines = raw.split("\n")
    if lines and lines[-1] == "":
        lines.pop()

    seen = {}
    for line_number, line in enumerate(lines, start=1):
        if line.strip() == "":
            errors.append(_error(path, line_number, "空白行"))
            continue

        fields = line.split("\t")
        if len(fields) != len(HEADER):
            hint = ""
            if "\t" not in line and " " in line:
                hint = "；本行沒有 tab，分隔符可能已被轉成空白"
            errors.append(_error(
                path,
                line_number,
                "欄位數 %d，應為 %d%s" % (len(fields), len(HEADER), hint),
            ))
            continue

        if line_number == 1:
            if tuple(fields) != HEADER:
                errors.append(_error(
                    path, line_number, "標題列應為 %s" % "／".join(HEADER)
                ))
            continue

        for field_name, value in zip(HEADER, fields):
            if value != value.strip():
                errors.append(_error(
                    path, line_number, "「%s」欄有多餘空白" % field_name
                ))

        term, replacement = fields
        if term == "":
            errors.append(_error(path, line_number, "「禁語」欄為空"))
            continue
        if replacement == "":
            errors.append(_error(
                path,
                line_number,
                "「替代用語」未指定時請填 -",
            ))
        if term in seen:
            errors.append(_error(
                path,
                line_number,
                "禁語「%s」重複（首見於第 %d 行）" % (term, seen[term]),
            ))
            continue
        seen[term] = line_number
        entries.append(Entry(
            term,
            "" if replacement == EMPTY else replacement,
        ))

    return entries, errors


def load_terms(path=TERMS_PATH):
    entries, errors = inspect_terms(path)
    if errors:
        raise TermsFileError(errors)
    return entries


def write_terms(entries, path=TERMS_PATH):
    """以 UTF-8、LF、真 tab 原子寫回詞庫。"""
    directory = os.path.dirname(os.path.abspath(path))
    descriptor, temporary_path = tempfile.mkstemp(
        prefix=".terms-", suffix=".tmp", dir=directory
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as handle:
            handle.write("\t".join(HEADER) + "\n")
            for entry in entries:
                handle.write("\t".join(
                    (entry.term, entry.replacement or EMPTY)
                ) + "\n")
        os.replace(temporary_path, path)
    except Exception:
        try:
            os.unlink(temporary_path)
        except OSError:
            pass
        raise


def clean_value(value, name, required=False):
    value = value.strip()
    if required and value == "":
        raise ValueError("%s不得為空" % name)
    if any(character in value for character in ("\t", "\r", "\n")):
        raise ValueError("%s不得含 tab 或換行" % name)
    return value


def command_add(args):
    term = clean_value(args.term, "禁語", required=True)
    replacement = clean_value(args.replacement, "替代用語")
    entries = load_terms()
    if any(entry.term == term for entry in entries):
        print("新增失敗｜「%s」已在詞庫中" % term, file=sys.stderr)
        return 1
    entries.append(Entry(term, replacement))
    write_terms(entries)
    print("已新增｜%s｜目前 %d 筆" % (term, len(entries)))
    return 0


def command_remove(args):
    term = clean_value(args.term, "禁語", required=True)
    entries = load_terms()
    remaining = [entry for entry in entries if entry.term != term]
    if len(remaining) == len(entries):
        print("刪除失敗｜詞庫中沒有「%s」" % term, file=sys.stderr)
        return 1
    write_terms(remaining)
    print("已刪除｜%s｜目前 %d 筆" % (term, len(remaining)))
    return 0


def _print_entry(entry):
    replacement = entry.replacement or "（未指定）"
    print("已收錄｜%s｜替代：%s" % (entry.term, replacement))


def command_query(args):
    entries = load_terms()
    by_term = {entry.term: entry for entry in entries}
    missing = False
    for raw_term in args.terms:
        term = clean_value(raw_term, "查詢詞", required=True)
        entry = by_term.get(term)
        if entry is None:
            print("未收錄｜%s" % term)
            missing = True
        else:
            _print_entry(entry)
    return 1 if missing else 0


def command_list(_args):
    entries = load_terms()
    print("詞庫共 %d 筆" % len(entries))
    for entry in entries:
        _print_entry(entry)
    return 0


def build_parser():
    parser = argparse.ArgumentParser(description="私人禁語詞庫操作工具")
    commands = parser.add_subparsers(dest="command", required=True)

    add = commands.add_parser("add", help="新增禁語")
    add.add_argument("term", help="要禁用的詞")
    add.add_argument("--replacement", "-r", default="", help="選填替代用語")
    add.set_defaults(handler=command_add)

    remove = commands.add_parser("remove", help="刪除禁語")
    remove.add_argument("term", help="要刪除的詞")
    remove.set_defaults(handler=command_remove)

    query = commands.add_parser("query", help="單筆或批次查詢")
    query.add_argument("terms", nargs="+", help="一個或多個完整禁語")
    query.set_defaults(handler=command_query)

    listing = commands.add_parser("list", help="列出全部禁語")
    listing.set_defaults(handler=command_list)

    return parser


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.handler(args)
    except (TermsFileError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
