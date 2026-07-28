# og_video.py — 貼文頁 og:video → mp4 直連解析器

用標準函式庫解析貼文頁的 [Open Graph](https://ogp.me/) `og:video` 標籤，取出 mp4 直連。
設計取向是**可控、可稽核**：沒有第三方相依、每一步都有紀錄。

## 為什麼不用 requests + bs4

| | 本方案 | requests + bs4 |
|---|---|---|
| 相依套件 | 0（純 stdlib） | 2 個直接 + 數個間接 |
| 供應鏈風險 | 無 | 需持續盯 CVE |
| 部署 | 複製單檔即可 | 需 pip install |
| 稽核 | 215 行全可讀 | 需信任套件內部行為 |

核心解析邏輯就是 `OGVideoParser` + `extract()`（`og_video.py:45-72`，28 行），
其餘是 CLI、稽核紀錄與防呆。

## 使用

```bash
# 最單純：印出 mp4 直連
python3 tools/og_video.py https://example.com/posts/123

# 完整 JSON（含稽核欄位：轉址、HTTP 狀態、HTML sha256、所有候選標籤）
python3 tools/og_video.py https://example.com/posts/123 --json

# 列出所有候選標籤（送到 stderr，不干擾 stdout 的管線）
python3 tools/og_video.py URL --all

# 下載（stdout 乾淨，可直接串接）
curl -L -o video.mp4 "$(python3 tools/og_video.py URL)"
```

| 參數 | 說明 |
|---|---|
| `--json` | 輸出完整稽核紀錄 |
| `--all` | 列出所有候選標籤 |
| `--no-robots` | 略過 robots.txt 檢查（已獲授權時使用） |
| `--audit PATH` | 稽核檔路徑（預設 `og_video_audit.jsonl`） |
| `--no-audit` | 不寫稽核紀錄 |
| `--timeout N` | 逾時秒數（預設 15） |
| `--user-agent S` | 自訂 User-Agent |

離開碼：`0` 找到、`1` 沒找到或出錯 —— 可直接用在 shell 判斷式。

## 標籤挑選規則

依序收集這四個標籤，**路徑以 `.mp4` / `.m4v` 結尾者優先**，同級再依下列順序：

1. `og:video:secure_url` — 通常是 mp4 直連
2. `og:video:url`
3. `og:video` — 有些站台這裡放的是 embed 播放頁，不是影片本身
4. `twitter:player:stream` — 退路

所以當 `og:video` 是 `/embed/player.html`、`og:video:secure_url` 是 `/v.mp4` 時，會正確挑後者。
若挑中的不是 `.mp4` 結尾，stdout 照樣輸出，但 stderr 會提示可能是 embed 頁。

## 可稽核性

每次執行附加一筆 JSONL：

```json
{
  "ts": "2026-07-28T16:08:05+00:00",
  "input_url": "https://example.com/posts/123",
  "final_url": "https://example.com/posts/123",
  "status": 200,
  "sha256": "67a13b4f43ad...",
  "robots": "robots.txt 允許",
  "candidates": {"og:video": "/embed/player.html", "og:video:secure_url": "/media/clip.mp4"},
  "video_url": "https://example.com/media/clip.mp4",
  "is_direct_mp4": true,
  "ok": true
}
```

- `candidates` 存**頁面原始宣告值**（未轉絕對網址），`video_url` 才是解析結果 —— 兩者並存才能對照出解析器做了什麼
- `sha256` 是抓到的 HTML 位元組雜湊，日後可證明當時看到的頁面內容
- `final_url` 記錄轉址後的真實位址

查詢用 `jq`：

```bash
jq -r 'select(.ok) | [.ts, .input_url, .video_url] | @tsv' og_video_audit.jsonl
jq -r 'select(.ok | not) | [.ts, .input_url, .error] | @tsv' og_video_audit.jsonl
```

## 安全與邊界

- **只讀公開 metadata** —— 不繞登入、不解 DRM、不碰私有 API
- **預設遵守 robots.txt**，被禁止就中止；抓不到 robots.txt 視為放行但記錄原因
- 只接受 `http` / `https`，擋掉 `javascript:` / `data:` 等 scheme
- 回應非 HTML 就拒絕解析，最多只讀 2 MB，避免誤抓大檔
- `&amp;` 自動還原 —— 簽章 query（`?sig=...&exp=...`）不會壞掉

## 限制

- **前端渲染的頁面抓不到**：`og:video` 必須存在於初始 HTML。純 JS 動態塞入的標籤看不到（這類站台需要無頭瀏覽器，超出本工具範圍）
- **簽章連結會過期**：多數 CDN 的 mp4 帶時效 token，解析出來要盡快使用
- **需登入的內容抓不到**：本工具不帶 cookie
- 沒有 `og:video` 標籤的頁面（例如影片走 HLS `.m3u8`）自然無法取得 mp4

## 測試

17 個離線測試，不連網：

```bash
python3 -m unittest discover -s tools -v
```

涵蓋：標籤優先序、embed 頁 vs mp4、`name=` 與 `property=` 兩種寫法、HTML entity 還原、
相對／協定相對網址、非 http scheme 阻擋、重複標籤、大小寫、殘破 HTML、稽核寫入。

## 合規提醒

請只對**你有權存取**的內容使用，並遵守目標站台的服務條款與著作權規定。
工具本身遵守 robots.txt，但 robots.txt 不等於授權 —— 最終責任在使用者。
