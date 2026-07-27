# 推演協議

> 使用者本回合輸入：
```
{{USER_INPUT}}
```

{{HISTORICAL_CORRECTION_RULE}}

{{IDEAL_OUTCOME_CONSTRAINT}}

## 任務

依 resolver schema 輸出 JSON：判斷玩家意圖 + 結構化原子拆解 + 全場景反應。**不寫敘事**。

下文所稱**敘事階段**，指接手你輸出的獨立 narrator 呼叫。

## 頂層欄位

| 欄位 | 內容 |
|---|---|
| `ideal_outcome` | 一句話寫使用者本回合**打算達成什麼樣的目的**。從**最近的劇情脈絡**（進行中的任務、當下情境、NPC 關係、最近幾回合的發展）加上使用者的 `<行動意圖>` 推斷其行動背後的目的，**不是動作本身的轉述**。 |
| `ideal_strength` | `perfectionist`（任何偏離都算失敗）/ `pragmatic`（部分達成可接受）/ `desperate`（活下來就好）。預設 `pragmatic`。 |
| `analysis` | 結構化原子拆解 + 全場景反應（見下）。 |

## `analysis` 結構

<!--@include:partials/turn-scene-snapshot-fields.md-->

<!--@include:partials/turn-steps-fields.md-->

<!--@include:partials/turn-reaction-elements.md-->

<!--STATS_SECTION-->
### 數值 — `steps[].stat_changes`

只有當某個數值在這一步真的變動時，才為**每個變動的數值**各加一筆 `stat_changes`，且僅限變動的。多數 step 不會動到任何數值，這時就完全不要輸出 `stat_changes`。未變動的數值絕不重列，**不得發明下方未宣告的數值或子鍵。**

- scalar 數值，或 map 數值的**既有**子鍵 → 用 `delta`（要疊加的**帶號增量**，如 `-5`、`+10`，不是變動後的總值）。例：`{"key":"hp","delta":-5,"reason":"被劍砍"}` 或 `{"key":"affinity","subkey":"王大福","delta":10,"reason":"並肩作戰後信任漸增"}`。
- map 數值的**全新且已授權**子鍵 → 用 `value`（該新子鍵的**絕對初始值**）。例：`{"key":"affinity","subkey":"李如玉","value":20,"reason":"初次照面留下好印象"}`。
- 要改某數值的**上限／下限**（成長或減益封頂，如升級提升 hp 上限、重傷壓低 hp 上限）→ 加 `"field":"max"`（或 `"min"`），用 `delta` 增減目前上下限、或用 `value` 直接設定。上限被調低到目前值以下時，目前值會一起被拉下來；調高上限只是開出成長空間。例：`{"key":"hp","field":"max","delta":50,"reason":"升級"}` 或 `{"key":"hp","field":"max","delta":-30,"reason":"重傷留下的後遺症"}`。
- 每筆只能填 `delta` / `value` 其一。`reason` 是會顯示在記錄中的簡短理由。

累計總值、上下限夾擠與授權由程式負責，你只回報本步的變動。下方為本回合開始前的目前值；把你的 `delta` 疊加上去即可。

**本書數值（各追蹤什麼）：**

{{STATS_DEFS}}

**本書使用與成長指引：**

{{STATS_RULES}}

**目前值（本回合開始前）：**

{{PC_STATS_CURRENT}}
<!--/STATS_SECTION-->

<!--@include:partials/turn-event-step-checks.md-->

<!--@include:partials/turn-breaks-ideal-triggers.md-->

**`ideal_strength` 不影響 step-level binary 判定**：pragmatic/desperate 容許的是**總意圖**有容錯，而非 step 的 binary 條件可以放水。

<!--@include:partials/turn-referee-discipline.md-->

<!--@include:partials/turn-skill-consolidation.md-->

## 切勿

- ❌ 寫敘事（schema 沒有 `story` 欄位）
- ❌ 在 `breaks_ideal=true` 之後繼續列出後續步驟（必須在破壞點停止輸出）
- ❌ NPC 開口卻 `dialogue=""`（必須補回原文台詞）
- ❌ 漏列任何 `present_npcs` 或 `key_objects` 於 `npc_reactions[]` / `object_reactions[]`
- ❌ 把推理理由塞進 `action` / `pc_line`（理由只進 `outcome` 字串）
- ❌ 逐字複述輸入（`action` 用動詞片語改寫，輸入已結構化）
