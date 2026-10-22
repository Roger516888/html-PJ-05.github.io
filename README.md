# 無人機百科

無人機**機型規格比較**的靜態網站，以 GitHub Pages 發佈。

## 這個站在做什麼

把各機型的續航、酬載、起飛重量、圖傳距離、抗風、感測器並列比較，並且**每個數字都標明來源**。

設計上的三個原則：

1. **續航是理想值。** 原廠標示的飛行時間幾乎都是無酬載、無風、懸停或定速、關閉避障的測試值，實際任務通常短 20–30%。每筆續航都附測試條件。
2. **查不到就留空。** 顯示「—」代表找不到可信的公開資料，不是 0，也不是「很小」。本站不填推測值。
3. **來源分級。** 以原廠官方規格頁為第一優先；採用非官方來源時會標記，並降低該機型的可信度等級。

## 檔案

| 檔案 | 用途 |
| --- | --- |
| `index.html` | 頁面結構 |
| `styles.css` | 樣式，含深色／淺色模式 |
| `script.js` | 載入資料、搜尋、篩選、排序、並列比較 |
| `drones.json` | **機型規格資料**（目前為空，待填） |

站台功能已完成並通過瀏覽器測試；`drones.json` 一填入資料就會自動長出篩選項與表格，不需要改程式。

## 資料格式

`drones.json` 的結構：

```json
{
  "meta": { "updated": "2026-10-22", "note": "選填說明" },
  "drones": [
    {
      "id": "dji-matrice-350-rtk",
      "name_en": "DJI Matrice 350 RTK",
      "name_zh": "DJI Matrice 350 RTK",
      "maker": "DJI",
      "maker_country": "中國",
      "category": "多旋翼",
      "tier": "企業",
      "year": 2023,
      "mtow_g": 9200,
      "weight_g": 6470,
      "max_payload_g": 2700,
      "flight_time_min": 55,
      "flight_time_note": "原廠標示值，測試條件請照抄原廠頁面",
      "max_range_km": null,
      "max_speed_kmh": null,
      "wind_resistance_ms": null,
      "ceiling_m": null,
      "ip_rating": "IP55",
      "rtk": true,
      "thermal": true,
      "lidar": true,
      "sensors": ["H30T", "L2 光達"],
      "price_note": null,
      "ndaa_status": "非NDAA相容",
      "notes": "版本與資料疑義寫在這裡",
      "confidence": "high",
      "sources": [
        { "url": "https://…", "official": true, "note": "官方規格頁" }
      ]
    }
  ]
}
```

欄位說明：

- 數值欄位單位固定：重量 `_g` 公克、時間 `_min` 分鐘、距離 `_km` 公里、速度 `_kmh` 公里/小時、抗風 `_ms` 公尺/秒、升限 `_m` 公尺。原始資料是磅或英尺要先換算，並在 `notes` 註明。
- **查不到的欄位一律填 `null`**，不要填 0 或估計值。
- `category`：`多旋翼` / `固定翼` / `VTOL複合` / `其他`
- `tier`：`消費` / `專業` / `企業` / `公務軍規`
- `ndaa_status`：`Blue UAS` / `NDAA相容` / `非NDAA相容` / `未確認`
- `confidence`：`high`（主要數字來自官方規格頁）/ `medium`（部分來自非官方）/ `low`（公開資料稀少或互相矛盾）
- `sources` 至少一筆，`official` 標明是否為原廠官方來源。

`category`、`tier`、`maker_country`、`ndaa_status` 的篩選選項是從資料自動產生的，新增值不必改程式。

## 本機預覽

`script.js` 用 `fetch()` 讀 `drones.json`，直接用 `file://` 開啟會被瀏覽器擋下，要起一個本機伺服器：

```bash
python3 -m http.server 8765
# 瀏覽器開 http://127.0.0.1:8765/
```
