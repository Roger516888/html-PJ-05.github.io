#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""檢查私人禁語詞庫的檔案格式與重複詞。"""

import sys

from terms import TERMS_PATH, inspect_terms


def main():
    entries, errors = inspect_terms(TERMS_PATH)
    if errors:
        sys.stderr.write("詞庫檢查失敗，共 %d 項問題：\n" % len(errors))
        for error in errors:
            sys.stderr.write("  %s\n" % error)
        return 1
    print("詞庫檢查通過｜禁語 %d 筆" % len(entries))
    return 0


if __name__ == "__main__":
    sys.exit(main())
