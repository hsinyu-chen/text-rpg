
- **0.數值.yaml**（第 10 個檔案，在上述 9 個之外——你也必須產出此檔）—— 本世界附帶了一份起始**數值帳本**，是引擎每回合追蹤的結構化數值系統（HP、MP、NPC 好感度等）。請**依此世界量身調整**，不要原樣保留通用範本：
  - 定義貼合類型的數值。每個數值條目使用 `type`（`scalar` = 單一數值；`map` = 每個子鍵各一個數值）、`value`（**基準值**）、`min`、`max`、`desc`、`color`（任何 CSS 顏色；`#hex` 需加引號）。挑選符合類型／基調的數值（例：恐怖題材的 `sanity`、犯罪世界的 `notoriety`、科幻的 `fuel`／`hull`），不適用的則刪除或改名。
  - 對 `map` 型數值（如 `affinity`），為你在 `3.人物狀態.md` 建立的每位**已知 NPC** 各加一個子鍵；若希望引擎能為新登場 NPC 自動新增子鍵，設 `allow_new_item: true`。
  - 提供一段簡短的 `rules:`，說明此世界中各數值如何升降；並加入 **1–2 個 `events`**，各含 `condition`、`type`（`level` 為真時每次觸發；`edge` 只在 false→true 跨越時觸發一次）與一句 `trigger` 敘事。
  - 帳本**只儲存基準值**——遊玩時的即時值由每回合的增減量推導，因此請勿在此預先寫死「目前」數字，只需設定合理的起始基準值。
  - **重要——本檔是上方「禁止使用 `replaceFile`」規則的明確例外。** 此 YAML 檔沒有 Markdown 標題，section 工具（`replaceSection`／`insertSection`）會被**拒絕**。你**必須**以 `replaceFile` **整份寫入** `0.數值.yaml`。若因 YAML 語法錯誤被拒，請讀取錯誤訊息，再以 `replaceFile` 整份重寫。
