# 私人禁語詞庫

這是使用者自己的禁語黑名單。使用者決定哪些詞不能用；專案不判斷詞源，
也不要求分類、權威來源或查證網址。

功能只包含新增、修改替代用語、刪除、單筆查詢、批次查詢與列出詞庫。

## 詞庫

唯一資料檔是 `terms.tsv`：

```text
禁語<TAB>替代用語
```

- `禁語`：必填，不能重複。
- `替代用語`：選填；未指定時由工具寫入 `-`。

原有詞條已完整移入這個單一詞庫；舊版的分類、依據、查證欄位，以及先前
誤加的批示欄位均已移除。

## 在對話視窗操作

直接交代即可：

```text
新增：視頻
新增：視頻｜替代：影片
改：視頻｜替代：短片
刪除：視頻
查詢：視頻
批次查詢：視頻、內卷、絕絕子
列出詞庫
```

代理會依照 `AGENTS.md` 呼叫同一支工具，不需要你手動編輯 TSV。

## 命令列

```bash
# 新增；替代用語可以省略
python3 scripts/terms.py add 視頻 --replacement 影片

# 修改已收錄詞的替代用語；省略替代用語代表清空
python3 scripts/terms.py set 視頻 短片
python3 scripts/terms.py set 視頻

# 刪除
python3 scripts/terms.py remove 視頻

# 單筆或批次查詢
python3 scripts/terms.py query 視頻
python3 scripts/terms.py query 視頻 內卷 絕絕子

# 列出全部
python3 scripts/terms.py list
```

所有寫入均固定為 UTF-8、LF、真 tab，並以原子替換避免寫到一半損壞詞庫。

`set` 會就地修改，不改變詞條在檔案中的位置；用 `remove` 再 `add` 則會把詞移到檔尾。

## 驗證

```bash
python3 scripts/lint.py
python3 -m unittest discover -s tests -v
```

檢查範圍只有維持工具可靠運作所需的項目：標題與欄位數、UTF-8／LF／檔尾
換行、禁語必填、欄位無前後空白，以及禁語不重複。GitHub Actions 會在 push
與 pull request 時執行檢查及操作測試。

---

原 `html-PJ-05.github.io` 靜態網站檔案 `index.html`、`script.js`、`styles.css`
仍保留，未納入這次詞庫工具改寫。
