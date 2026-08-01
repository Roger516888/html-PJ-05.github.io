# 私人禁語詞庫操作規則

這個 repository 是使用者自己的禁語黑名單，不是辭典或研究資料庫。

## 核心原則

- 使用者指定某詞禁用時，直接收錄；不要要求權威來源、分類或查證網址。
- 替代用語為選填。使用者只說「禁：某詞」也能新增。
- 功能只包含新增、刪除、單筆／批次查詢與列出；不要另增批示欄位或指令。
- 所有變更都透過 `python scripts/terms.py` 完成，不要手動拼接 TSV。
- 每次變更後執行 `python scripts/lint.py` 與測試。

## 視窗指令對應

| 使用者說法 | 執行動作 |
|---|---|
| `新增：禁語` | `python scripts/terms.py add 禁語` |
| `新增：禁語｜替代：用語` | `python scripts/terms.py add 禁語 --replacement 用語` |
| `改：禁語｜替代：用語` | `python scripts/terms.py set 禁語 用語` |
| `刪除：禁語` | `python scripts/terms.py remove 禁語` |
| `查詢：禁語` | `python scripts/terms.py query 禁語` |
| `批次查詢：詞一、詞二` | `python scripts/terms.py query 詞一 詞二` |
| `列出詞庫` | `python scripts/terms.py list` |

操作完成後，只需回報結果與目前總筆數。除非使用者另外要求，不做網路查證。
