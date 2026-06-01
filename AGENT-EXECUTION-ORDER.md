# Multi-Agent Save — 全開狀態 agent 執行順序

本文件描述**所有 agent 都啟用**時,一次 save 從頭到尾的 agent 執行順序與資料流。所有 advanced-save agent 預設 **OFF**(成本考量,使用者逐一 opt-in),「全開」指使用者把 `enabledSaveAgents` 三個都打開的狀態。

> 權威來源:執行順序由 [multi-agent-save.providers.ts](src/app/core/services/multi-agent-save/multi-agent-save.providers.ts) 的 `ADVANCED_SAVE_AGENT` multi-provider **宣告順序**決定;[advanced-save-stage.service.ts](src/app/core/services/multi-agent-save/advanced-save/advanced-save-stage.service.ts) 逐字照 registry 順序跑,只跳過未啟用的。本文件若與這兩個檔不符,以程式碼為準。

## 整體流程

```
使用者觸發 Save
   │
   ▼
MultiAgentSaveService.run()                        ← multi-agent-save.service.ts
   │  1. snapshot context(provider / cache / history / lang)
   │  2. 載入 save_manifest prompt + 組 user message
   │  3. ┌─────────────────────────────────────────┐
   │     │ SaveAgentRunnerService.run()            │ ← 單發 LLM call
   │     │   → SaveHunk[](manifest)                │   save-agent-runner.service.ts
   │     └─────────────────────────────────────────┘
   │  4. ┌─────────────────────────────────────────┐
   │     │ AdvancedSaveStageService.process()      │ ← 進階存檔鏈(見下)
   │     │   hunks → agent → agent → … → hunks      │   advanced-save-stage.service.ts
   │     └─────────────────────────────────────────┘
   │  5. 每條 hunk → FileUpdate
   │  6. setWorkComplete(true)
   │  7. AutoUpdateDialog(套用)
   ▼
完成
```

進階存檔鏈把 hunk 清單一棒接一棒地穿過每個**啟用中**的 agent:
`hunks → agent[0] → agent[1] → agent[2] → 最終 hunks`。每個 agent 收到完整 hunk 清單、回傳完整處理後清單(自行篩選它在乎的),未啟用的直接跳過,不擾動順序。零個啟用 = 整段 identity pass。

## 全開時的 agent 順序

| # | Agent | id (`enabledSaveAgents` key) | 目標檔 | Prompt | 模式 |
|---|---|---|---|---|---|
| 0 | **SaveAgentRunner** | — (永遠跑,非 advanced) | 全部 KB | `save_manifest` | 單發 call → manifest |
| 1 | **InventoryConsistencyAgent** | `inventory-consistency` | `9.物品欄.md` / `4.資產.md` / `5.科技裝備.md` / `6.勢力與世界.md`(物品範圍) | `save_inventory_consistency` | 單發 call(看全部 hunk) |
| 2 | **CharacterStateAgent** | `character-state` | `3.人物狀態.md` | `save_character_state` | **序列 per-entity**(每角色一發 call) |
| 3 | **FactionStateAgent** | `faction-state` | `6.勢力與世界.md` | `save_faction_state` | **序列 per-entity**(每勢力一發 call) |

檔案位置:
- InventoryConsistencyAgent → [inventory-consistency-agent.ts](src/app/core/services/multi-agent-save/advanced-save/inventory-consistency-agent.ts)
- CharacterStateAgent → [character-state-agent.ts](src/app/core/services/multi-agent-save/advanced-save/per-entity/character-state-agent.ts)
- FactionStateAgent → [faction-state-agent.ts](src/app/core/services/multi-agent-save/advanced-save/per-entity/faction-state-agent.ts)(兩者共用 [base-per-entity-state-agent.ts](src/app/core/services/multi-agent-save/advanced-save/per-entity/base-per-entity-state-agent.ts))

## 為什麼是這個順序

**Inventory 排最前**:character / faction agent 可能會 verify「角色持有 X 物品」這類陳述。先讓 inventory agent 把物品欄 hunk 清乾淨,後面 agent 看到的 hunk list 更穩定。

**Character 在 Faction 之前**:無硬性依賴,但多數使用者只開 character(角色變動快、值得逐一推演)不開 faction(勢力變動慢)。拆成兩個獨立 agent 就是為了支援「只開其中一個」。

## Per-entity agent 的內部順序(全開時)

CharacterStateAgent / FactionStateAgent 不是單發 call,而是對 provider 列出的**每個 entity 各跑一發獨立 LLM 對話**(視角不能 mix),且 **Phase 1 一律序列**(base loop 靠 singleton instance state 跑單一對話,並行會互相踩;雲端並行屬 Phase 2 perf 重構)。

```
CharacterStateAgent.process()
   │  provider.listCharacters(files) → [角色A, 角色B, …]
   │  (空清單 → warn + skip,identity passthrough)
   │
   ├─ 角色A:seed(格式範本 + 人物卡 + 該角色 hunk + 時間跨度 + log digest)
   │         → loop(讀 KB / 讀對話)→ commitEntityStateReview 或 reportNotAnEntity
   │         → apply 到 hunks(限該角色 section)
   ├─ 角色B:同上
   └─ …
   │
   └─ 收尾:若 ≥4 entity 且 ≥50% 被判 reportNotAnEntity → 補一條格式不相容彙總警告
```

每個 entity 在同一發 call 內同時做兩件事(prompt 要求):
- **Job A 事實校驗 / 深化**(永遠做):verify / revise SaveAgent 已寫的 hunk、補漏寫的真實更新。
- **Job B 時間流逝推演**(時間跨度有實質長度時,LLM 自行判斷):character 是傷勢復原 / 心態延續 / off-screen 計畫;faction 是內部動向 / 領導層 / 跨勢力張力。

FactionStateAgent 流程結構完全相同,只是 `listFactions` + 目標 `6.勢力與世界.md` + faction 版 prompt。

## 失敗 / 中止行為

- **單一 advanced agent 失敗** → degrade 成 identity(該 agent 不動 hunk,鏈往下走),不會 sink 整個 save。
- **per-entity 單一 entity 失敗** → 只退化那一個 entity 為 passthrough,同 agent 其餘 entity 照跑。
- **使用者中止** → stage 在 agent 之間檢查 `signal.throwIfAborted()`,不會多花一發 LLM call。
