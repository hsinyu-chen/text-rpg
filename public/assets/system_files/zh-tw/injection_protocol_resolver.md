# 推演協議（Call 1 — Resolver）

> 使用者本回合輸入：
```
{{USER_INPUT}}
```

{{HISTORICAL_CORRECTION_RULE}}

{{IDEAL_OUTCOME_CONSTRAINT}}

## 任務

依 resolver schema 輸出 JSON：判斷玩家意圖 + 結構化原子拆解 + 全場景反應。**不寫敘事**。

## 頂層欄位

- **`ideal_outcome`**：一句話寫使用者**整串輸入**想達成什麼（含台詞之後預期反應）。範例：「主角想以握手禮自我介紹給陌生路人並建立善意聯繫」。
- **`ideal_strength`**：`perfectionist`（任何偏離都算失敗，如「精準命中眉心」）/ `pragmatic`（部分達成可接受，如「打贏這場架」）/ `desperate`（活下來就好，如「逃出包圍」）。預設 `pragmatic`。
- **`analysis`**：見下。

## `analysis` 結構

### `analysis.scene_snapshot`

程式會用本區欄位組裝故事頁首 `[<date_in_world> <time_hhmm> / <location> / <角色們>]`，因此每欄都要填妥。**不要**自己寫 `[...]` 那行。

| 欄位 | 規範 |
|---|---|
| `date_in_world` | 含曆法名+年月日+週幾的單一字串。範例：`"聖曆 1000年04月02日 週二"`。曆法名稱必須來自 `{{FILE_BASIC_SETTINGS}}`。**跨午夜時必須進日**。 |
| `time_hhmm` | 本回合**結束時刻** "HH:MM"，依前回合 + 本回合動作合理推估，**精確到分鐘**。連續多回合不可保持同一時刻。 |
| `location` | 場景所在處，範例：`"新手村 - 冒險者公會櫃檯"` / `"旅店一樓"`。供頁首組裝。 |
| `environment` | 自由 prose 融合天氣／氛圍／特殊修正條件。範例：`"暴雨中，視線不佳，地板濕滑"`。**與 `location` 不同**——這是感官氛圍而非地點名稱。空場景可 `""`。 |
| `pc_in_header` | 主角在頁首中的呈現，含化名 `[]` 與狀態 `()`。範例：`"程楊宗"` / `"程楊宗[魯蛇]"` / `"程楊宗(化裝中)"`。 |
| `present_npcs[]` | 在場 NPC。`{name, state}`：`state` 是**戰爭迷霧／意識狀態**——用於判定該 NPC 本回合**是否具備對環境／PC 行動的反應能力**。自由發揮但限於該範疇。常用 tag：`"昏迷"` / `"熟睡"` / `"麻痺"` / `"匿蹤"` / `"通訊"`；可自創同範疇短 tag（如 `"幻象"` / `"靈魂出竅"`）。`""` = 清醒在場且具完整反應能力（預設）。**禁止情緒、當下行為或活動**（如 `"旁觀"` / `"交談中"` / `"抱著X"` / `"敵意"` 等屬於 `npc_reactions[].physical` 與 `motivation`）。 |
| `key_objects[]` | 重要環境物件（機關／陷阱／關鍵道具）。`{name, state}`。普通家具不列。空填 `[]`。 |

### `analysis.steps[]`

依使用者輸入順序拆解原子動作。**不可短路**——即使第一步 `breaks_ideal=true` 仍須列出剩餘步驟。

每個 step：

- **`action`** — 動詞片語（含目標）。**不要逐字複述輸入**。
- **`pc_dialogue`** — 主角本步台詞**原文**，無則 `""`。**禁止潤飾／意譯**。
- **`mood`** — 主角心境（呼應 `[心境]`）。無則 `""`。
- **`risk_factors[]`** — 風險清單，例如 `["梨菲反擊", "大雨影響命中"]`。即使最終成功也要列。
- **`outcome`** — 單一 free-text 判定：`"成功 - 勉強站穩"` / `"部份成功 - 達成A但B被拒"` / `"伴隨代價的成功 - 翻牆但扭傷腳踝"` / `"失敗 - 梨菲閃過並反擊"`。
- **`breaks_ideal`** — 布林。`true` 時 `outcome` 以「失敗」起頭；`false` 時以「成功 / 部份成功 / 伴隨代價的成功」起頭。
- **`npc_reactions[]`** — **`scene_snapshot.present_npcs` 每位都必須出現一筆**（含旁觀沉默／昏迷／通訊）。
- **`object_reactions[]`** — **`scene_snapshot.key_objects` 每個都必須出現一筆**（含「無變化」）。

#### `npc_reactions[]` 元素

- **`actor`** — 必須對應 `present_npcs[].name`。
- **`physical`** — 動作／姿態／表情／眼神。沉默旁觀／昏迷也要寫狀態。
- **`dialogue`** — NPC 本步台詞**原文**。沒開口則 `""`。**有開口必填**——禁止用「用某某口吻回應」「嘲笑著說」這類動作轉述代替台詞。
- **`motivation`** — 動機標註：`"戰鬥本能+敵意"` / `"恐懼+逃避"` 等。可空 `""`。

#### `object_reactions[]` 元素

- **`name`** — 必須對應 `key_objects[].name`。
- **`change`** — 狀態未變且未被互動：填保留字串 `"無變化"`。首次登場：詳述初始狀態。被互動或變化：寫具體變化。

### `analysis.random_event`

`{triggered, description}`。`triggered=false` 時 `description=""`。

## `breaks_ideal=true` 觸發條件（任一）

1. 能力不足
2. NPC 拒絕（依其自主性與人格）
3. 環境硬性阻擋
4. 隨機事件中斷
5. 代理權衝突（主角無權替 NPC 決定）

## 判定規則

執行 `system_prompt.md` 的【Thinking 模式指引】所有檢核（事前盤點 / 裁判 / NPC 代言人 / 故事設計師），**內化**為每一步的 `breaks_ideal` 判定。推理留在 thinking，不進輸出。
