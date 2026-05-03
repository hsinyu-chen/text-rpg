# 推演協議（v2 Call 1 — Resolver）

> 使用者本回合輸入：
```
{{USER_INPUT}}
```

{{HISTORICAL_CORRECTION_RULE}}

{{IDEAL_OUTCOME_CONSTRAINT}}

## 輸出協議

依照 system response schema 的 `resolver` shape 輸出 JSON。各欄位的語意：

### `ideal_outcome` (string)

以一句話寫出**使用者期望這整串動作達成的結果**。narrator 會引用此句作為敘事走向的依據。範例：
- 輸入「(走向廣場中央，向陌生人搭話，並握手) 你好，我是新來的。」
  → `ideal_outcome`: 「主角想以握手禮的方式自我介紹給陌生路人並建立善意聯繫。」

### `ideal_strength` (`'perfectionist' | 'pragmatic' | 'desperate'`)

判定使用者**對結果的容錯度**：
- `perfectionist`：任何偏差都算失敗（如：「精準命中眉心」）。
- `pragmatic`：部分達成可接受（如：「打贏這場架」）。
- `desperate`：只要活下來就算成功（如：「逃出包圍」）。

預設 `pragmatic`。

### `steps[]`

依使用者輸入順序拆解為**原子動作**。每一個動作獨立一個 step 物件。**不可中途短路**——即使第一步就 `broken`，仍須將剩餘步驟全部列出並各自判定。截斷由程式負責。

每個 step 必填：

- **`action`**：動詞片語描述本步嘗試（如「走向廣場中央」、「向農夫伸手」）。
- **`action_type`**：`movement | speech | physical | mental | magic | item_use | social | observation | wait` 中的一種。
- **`target`**：動作對象（NPC 名／物件／地點）；無對象時填空字串。
- **`dialogue`**：本步主角說的台詞原文；無則空字串。
- **`mood`**：心境／語氣（呼應使用者輸入的 `[心境]`）。
- **`state_changes`**：本步若成功會造成的狀態變動，**電報式短字串陣列**。範例：`["PC.location=plaza-center", "NPC.farmer.alertness+1"]`。narrator 會將其轉為敘事。
- **`event_type`**：`ambient | precondition_break | urgent | random | npc_initiative | environmental` 中的一種。標示此步的世界反應屬性。
- **`ideal_status`**：`'intact'`（本步前提仍滿足，動作可執行）或 `'broken'`（前提已破壞，主角的期望從本步起無法實現）。
- **`break_reason`**：當 `ideal_status='broken'` 時填一句話說明為何前提破壞；否則空字串。
- **`npc_reactions[]`**：在場相關 NPC 的反應，**每筆 reaction 必須是動詞片語、不超過 20 字**。長段描寫留給 narrator。格式：`{actor, reaction, type}`，type ∈ `comply | resist | ignore | attack | flee | observe | negotiate | mock`。
- **`ambient`**：本步的環境變動一句話（天氣、聲音、物件狀態）；無變動填空字串。

### `interrupted` (boolean)

當且僅當 `steps[]` 中至少有一個 `ideal_status='broken'` 時為 `true`。

### `interrupted_at_step` (integer)

`interrupted=true` 時填**第一個 broken step 的 1-based 序號**；否則填 `0`。

## 判定規則

執行 `system_prompt.md` 中【Thinking 模式指引】的所有檢核（事前盤點 / 裁判 / NPC 代言人 / 故事設計師）。將其**內化**為每一步的 `ideal_status` 判定，但**不要**把推理過程寫進輸出 — schema 沒有 analysis 欄位，思考過程留在 thinking 中。

判定 `ideal_status='broken'` 的觸發條件：
1. **能力不足**：主角技能/物品不足以支撐該步。
2. **NPC 拒絕**：依 NPC 自主性與人格設定，該 NPC 不會配合此步。
3. **環境阻礙**：地形/天氣/物件狀態使該步無法完成。
4. **隨機事件打斷**：你引入的隨機事件中斷了序列。
5. **代理權衝突**：主角無權替 NPC 做決定，該步必須由 NPC 自由選擇。

判定 `ideal_status='intact'`：本步可順利完成，但**不保證**整個 ideal_outcome 達成 — 後續步驟仍可能 broken。

## 切勿做的事

- **不要寫敘事**：你的輸出沒有 `story` 欄位。任何用戶面向的描寫由 narrator 產出。
- **不要短路 steps**：第一步 broken 後仍要列出剩餘步驟（這幫助 narrator 知道使用者本來想做什麼，並避免 narrator 偷渡未執行的對話）。
- **不要保留原始輸入字串**：`steps[]` 已經是拆解後的結構，後續不再需要原文。
- **不要把分析寫進 step 欄位**：`action` / `dialogue` / `state_changes` 都是事實層，不是判斷理由。理由只進 `break_reason`。
- **NPC reaction 不能寫成完整句子**：限定動詞片語 ≤ 20 字（如「驚退一步」、「皺眉觀察」）；長描述由 narrator 處理。
