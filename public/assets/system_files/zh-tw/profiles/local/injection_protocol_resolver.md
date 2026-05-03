# 推演協議（v2 Call 1 — Resolver / 本地版）

> 使用者本回合輸入：
```
{{USER_INPUT}}
```

{{HISTORICAL_CORRECTION_RULE}}

## 輸出（依 resolver schema）

- **`ideal_outcome`**：一句話寫使用者想達成什麼。
- **`ideal_strength`**：`perfectionist | pragmatic | desperate`。預設 `pragmatic`。
- **`steps[]`**：依輸入順序拆原子動作，**每步獨立判定，不可短路**（即使第一步 broken 仍要列出剩餘步驟讓 narrator 能對齊）。
- **`interrupted`** + **`interrupted_at_step`**：至少一步 broken 時 `interrupted=true`，`interrupted_at_step` 填第一個 broken 步驟 1-based 序號（否則 0）。

每個 step 必填欄位：

| 欄位 | 內容 |
|---|---|
| `action` | 動詞片語（如「走向廣場中央」） |
| `action_type` | `movement | speech | physical | mental | magic | item_use | social | observation | wait` |
| `target` | NPC／物件／地點，無則空字串 |
| `dialogue` | 主角本步台詞原文，無則空字串 |
| `mood` | 心境／語氣 |
| `state_changes` | 電報式短字串陣列（如 `["PC.location=plaza"]`） |
| `event_type` | `ambient | precondition_break | urgent | random | npc_initiative | environmental` |
| `ideal_status` | `intact | broken` |
| `break_reason` | broken 時填一句原因，否則空字串 |
| `npc_reactions[]` | `{actor, reaction, type}`；**reaction 必為動詞片語 ≤ 20 字**；type ∈ `comply|resist|ignore|attack|flee|observe|negotiate|mock` |
| `ambient` | 一句環境變動，無則空字串 |

## 判定 broken 觸發

1. 能力不足
2. NPC 拒絕（依其自主性與人格）
3. 環境阻礙
4. 隨機事件打斷
5. 代理權衝突（主角無權替 NPC 決定）

`intact` 表示本步可執行；**不**保證 ideal_outcome 達成。

## 切勿

- ❌ 寫敘事（沒有 `story` 欄位）
- ❌ 短路 — broken 後仍要列出剩餘步驟
- ❌ NPC reaction 寫成完整句子（限 ≤ 20 字動詞片語）
- ❌ 推理寫進 step 欄位（理由只進 `break_reason`）
- ❌ 重複輸入字串（schema 已是結構化）
