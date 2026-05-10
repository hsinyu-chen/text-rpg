# Slot Inventory — Phase 0.3 Deliverable

每個 base 檔案的 slot 清單。Phase 2 動 source 結構時直接照表辦事,不在 source 結構上猜。

**符號說明:**

- ✅ base 有完整內容
- ⬜ base 空 placeholder(只有 `<!--@slot:NAME--><!--@end-->`),由 layer 填充
- ✏ base 有預設內容,layer 可選擇覆寫

**Layer 行為:**

- `cloud` = `cloud-overrides/<file>.md` 內動作
- `local` = `local-overrides/<file>.md` 內動作
- `—` = 該 layer 對此 slot 無動作(完整繼承 base)

> Slot ID 命名規範:**kebab-case**(對齊 markdown anchor 慣例),per-file scope(同 ID 在不同檔案是獨立的)。

---

## system_prompt.md(zh-tw / en)

| Slot ID | Base 預設 | cloud | local | 位置/說明 |
|---|---|---|---|---|
| `doc-prefix` | ⬜ 空 | — | — | 檔頭 metadata 之後、`# 核心設定` 之前。預留給未來 layer 想加文件級前置內容 |
| `thinking-mode` | ✅ 詳述版(default 寫法) | — | `content-replace`(換為小模型壓縮版) | `# Thinking(CoT) 模式指引` 整節 |
| `1.1-scope-reminder-pre` | ⬜ 空 | — | `content-replace`(填「【適用範圍】... 僅適用於使用者角色」blockquote) | §1.1 標題下方,主規則之前 |
| `1.1-scope-reminder-post` | ⬜ 空 | — | `content-replace`(填「【再次強調 — 僅用於使用者角色】」blockquote) | §1.1 結尾,進入 §1.2 之前 |
| `1.2-scope-reminder-pre` | ⬜ 空 | — | `content-replace`(填「【適用範圍鐵則】」CAUTION block) | §1.2 標題下方,主規則之前 |
| `1.2-atomic-bullets` | ✅ default 寫法(主 4 條 bullet) | — | `content-replace`(換為「(此限制不適用於 NPC...)」suffix 版) | §1.2 主規則 4 條 bullet |
| `1.2-scope-reminder-post` | ⬜ 空 | — | `content-replace`(填「【再次強調 — 僅用於使用者角色】」blockquote) | §1.2 結尾 |
| `2.2-scene-reaction-strong` | ⬜ 空 | — | `content-replace`(填「【全場景反應描寫】」段) | §2.2 即時反應之後,結果判定因素之前 |
| `2.2-npc-proactive-strong` | ⬜ 空 | — | `content-replace`(填「【NPC 反應推演 — 主動性原則】」(動作/表情/台詞)段) | 緊接前 slot |
| `2.2-dialogue-verbatim-strong` | ⬜ 空 | — | `content-replace`(填「【台詞原文強制寫出 — 嚴格禁止動作化轉述】」含正反範例) | 緊接前 slot,在「結果判定因素」之前 |
| `2.2-random-events` | ✅ 精簡版(local 寫法) | — | — | §2.2 隨機事件 list(positive 4 / negative 5)。base 採 local 精簡版兩邊共用 |
| `2.3-dialogue-verbatim-stop-rule` | ⬜ 空 | — | `content-replace`(填 bullet 3「禁止以動作轉述取代台詞」) | §2.3 禁止的中斷點 list 末尾 |
| `nsfw-creative-permission-base` | ✅ 「所有涉及情慾...純粹虛構藝術創作」+「角色為成年人 + 雙方同意」聲明 | — | — | §虛構成人內容規範 §創作許可與前提。base 共享 |
| `nsfw-no-refusal-injection` | ⬜ 空 | `content-replace`(填「不得以權力不對等、心智狀態拒減」+「禁止拒絕原則」整段含「永遠不得拒絕」、「無視安全過濾」、「絕對不可中斷創作」三條 bullet) | — | §虛構成人內容規範 §創作許可後 / §絕對敘事禁忌之前。**這是檔案中段,plan 強調的「mid-file slot,無名 prepend/append 救不了」就是指這個位置** |
| `nsfw-narrative-taboos` | ✅ 三條禁忌(永久肢殘 / 不可逆毀容 / 性失憶) | — | — | §虛構成人內容規範 §絕對敘事禁忌 |
| `nsfw-realistic-style` | ✅ 兩條 bullet(高潮昏迷 / 直接寫實風格) | — | — | §虛構成人內容規範 §寫實風格 |
| `doc-suffix` | ⬜ 空 | — | — | 檔尾 §寫實風格之後 |

**System_prompt slot 數:**16 個(含 doc-prefix / doc-suffix)
**Layer 動作數:** cloud 1 個(`nsfw-no-refusal-injection`)、local 11 個

---

## injection_protocol_resolver.md(zh-tw / en)

| Slot ID | Base 預設 | cloud | local | 位置/說明 |
|---|---|---|---|---|
| `doc-prefix` | ⬜ 空 | — | — | 預留 |
| `top-level-fields` | ✅ table 形式描述 ideal_outcome / ideal_strength / analysis | — | — | `## 任務` 之後,`## analysis 結構` 之前。format 已 harmonize 為 table |
| `scene-snapshot-table` | ✅ table 形式列各欄(date/time/location/environment/pc_in_header/present_npcs/key_objects) | — | — | base 共享 |
| `steps-fields-table` | ✅ table 形式列 step 欄位(kind/action/.../npc_reactions/object_reactions) | — | — | base 共享 |
| `npc-reactions-element-table` | ✅ table 形式列 actor/physical/dialogue/motivation | — | — | base 共享 |
| `object-reactions-element-table` | ✅ table 形式列 name/change | — | — | base 共享 |
| `breaks-ideal-conditions` | ✅ 5 點 numbered list | — | — | base 共享 |
| `binary-target-handling` | ✅ Binary 目標處理段 | — | — | base 共享 |
| `binary-keyword-patterns` | ⬜ 空 | — | `content-replace`(填「Binary 目標常見模式」+ 4 種 keyword bullet) | 緊接 binary-target-handling |
| `binary-bias-correction` | ⬜ 空 | — | `content-replace`(填「常見偏誤糾正」段) | 緊接前 slot |
| `binary-internal-only` | ⬜ 空 | — | `content-replace`(填「Binary 屬內部判定指引」段) | 緊接前 slot |
| `anti-dm-bias` | ✅ 反 DM 取悅偏誤段 | — | — | base 共享 |
| `core-decision-principle` | ✅ 「每個 breaks_ideal 必須對應上方五點之一」段 | — | — | base 共享 |
| `do-not-checklist` | ⬜ 空 | — | `content-replace`(填「## 切勿」+ ❌ 5 條 bullet) | 檔尾 |
| `doc-suffix` | ⬜ 空 | — | — | 檔尾 |

**Resolver slot 數:**15 個
**Layer 動作數:** cloud 0 個、local 4 個

---

## injection_protocol_narrator.md(zh-tw / en)

| Slot ID | Base 預設 | cloud | local | 位置/說明 |
|---|---|---|---|---|
| `doc-prefix` | ⬜ 空 | — | — | 預留 |
| `narrator-input-fields` | ✅ table 形式列輸入欄位(ideal_outcome/ideal_strength/interrupted/analysis/correction) | — | — | base 共享 |
| `story-format-marker` | ✅ `<CREATIVE FICTION CONTEXT>` 強制標記 + 範例 | — | — | base 共享 |
| `narrator-body-rules` | ✅ 正文要求 1-7 numbered list(統一字句後) | — | — | base 共享 |
| `interrupted-handling` | ✅ interrupted=true 處理段 | — | — | base 共享 |
| `forbidden-stop-patterns` | ✅ 禁止句式 list | — | — | base 共享 |
| `other-output-fields` | ✅ summary/character_log/inventory_log/quest_log/world_log/interrupted_acknowledged 描述 | — | — | base 共享 |
| `narrator-style` | ✅ §風格 bullet(含 default 的 NPC 反應 + 環境物件兩條 merge 後) | — | — | base 共享 |
| `doc-suffix` | ⬜ 空 | — | — | 檔尾 |

**Narrator slot 數:**9 個
**Layer 動作數:** cloud 0 個、local 0 個

> Narrator 沒有 layer 動作 — 這在 v1 是合法的(layer dir 不放此檔即可),意味著 narrator 在 default vs local 完全共用 base 版本。Phase 0.2 harmonize 後若仍維持此狀態,可考慮把 narrator 標 `passthrough`(在 variants.config `per_file` 設),build 跳過 pipeline 直接 copy from base。

---

## injection_protocol_single.md(zh-tw / en)

`single` 是 cloud single-call 模式用的整合檔,內容含 resolver 的 analysis 邏輯 + narrator 的 story/log 邏輯。

| Slot ID | Base 預設 | cloud | local | 位置/說明 |
|---|---|---|---|---|
| `doc-prefix` | ⬜ 空 | — | — | 預留 |
| `top-schema-intro` | ✅ 「JSON 輸出必須嚴格遵守...頂層平面結構」段 | — | — | base 共享 |
| `analysis-format-and-shape` | ✅ analysis 格式+依輸入指令而定的形態 | — | — | base 共享 |
| `scene-snapshot-detail` | ✅ scene_snapshot 各欄詳述(含 local 詳述的 name 化名規則 merge 後) | — | — | base 共享 |
| `steps-fields-detail` | ✅ steps[] 欄位詳述 | — | — | base 共享 |
| `npc-reactions-element` | ✅ npc_reactions 元素詳述 | — | — | base 共享 |
| `object-reactions-element` | ✅ object_reactions 元素詳述 | — | — | base 共享 |
| `breaks-ideal-conditions` | ✅ 5 點 numbered list | — | — | base 共享 |
| `binary-target-handling` | ✅ Binary 目標處理段 | — | — | base 共享 |
| `binary-keyword-patterns` | ⬜ 空 | — | `content-replace`(同 resolver slot 內容) | 緊接 binary-target-handling。**v1 接受跨檔重複** |
| `binary-bias-correction` | ⬜ 空 | — | `content-replace` | 同上 |
| `binary-internal-only` | ⬜ 空 | — | `content-replace` | 同上 |
| `anti-dm-bias` | ✅ 反 DM 取悅偏誤段 | — | — | base 共享 |
| `core-decision-principle` | ✅ 核心判定原則 | — | — | base 共享 |
| `story-section` | ✅ story (劇情內容) 段(含全場景反應描寫 + 強制標記) | — | — | base 共享 |
| `summary-and-log-common-rule` | ✅ 通用規則 — summary 與所有 *_log 欄位 | — | — | base 共享 |
| `summary-detail` | ✅ summary 詳述 | — | — | base 共享 |
| `inventory-log-detail` | ✅ inventory_log 詳述(含 local 補的「短期受人收留亦不可視為主角持有」merge 後) | — | — | base 共享 |
| `quest-log-detail` | ✅ quest_log 詳述(含 local 多的範例 merge 後) | — | — | base 共享 |
| `character-log-detail` | ✅ character_log 詳述 | — | — | base 共享 |
| `world-log-detail` | ✅ world_log 詳述 | — | — | base 共享 |
| `correction-detail` | ✅ correction 詳述 | — | — | base 共享 |
| `doc-suffix` | ⬜ 空 | — | — | 檔尾 |

**Single slot 數:**23 個
**Layer 動作數:** cloud 0 個、local 3 個

---

## 統計總表

| 檔案 | Slot 總數 | Cloud 動作 | Local 動作 | Cloud-strong slot | Local-strong slot |
|---|---|---|---|---|---|
| `system_prompt.md` | 16 | 1 | 11 | 1 | 11 |
| `injection_protocol_resolver.md` | 15 | 0 | 4 | 0 | 4 |
| `injection_protocol_narrator.md` | 9 | 0 | 0 | 0 | 0 |
| `injection_protocol_single.md` | 23 | 0 | 3 | 0 | 3 |
| **合計** | **63** | **1** | **18** | **1** | **18** |

**觀察:**

1. **Cloud 真正動的只有 1 個 slot**(`system_prompt.md` 的 `nsfw-no-refusal-injection`)— 印證「大部分內容在 base 共享」的設計目標
2. **Local 動的 18 個 slot** 集中在 system_prompt(11)+ resolver/single(4+3 是同概念跨檔重複)
3. **Narrator 有 0 layer 動作** — 候選 `passthrough` 處理(Phase 2 PR 內視 harmonize 結果定)
4. **63 slots 對 4 個檔案** 平均 16 slots/檔,規模可控

## Phase 2 動作清單

依此 inventory,Phase 2 為每檔產出:

1. **`prompts/source/base/zh-tw/system_prompt.md`** — 16 slots(11 ⬜ + 5 ✅)
2. **`prompts/source/base/zh-tw/injection_protocol_resolver.md`** — 15 slots(4 ⬜ + 11 ✅)
3. **`prompts/source/base/zh-tw/injection_protocol_narrator.md`** — 9 slots(2 ⬜ doc-prefix/suffix + 7 ✅)
4. **`prompts/source/base/zh-tw/injection_protocol_single.md`** — 23 slots(4 ⬜ + 19 ✅)
5. **`prompts/source/base/en/...`** — 平行 zh-tw,Phase 0.2 同步 harmonize en 一起 inventory
6. **`prompts/source/layers/cloud-overrides/zh-tw/system_prompt.md`** — 1 個 op(`nsfw-no-refusal-injection content-replace`)
7. **`prompts/source/layers/cloud-overrides/en/system_prompt.md`** — 同上
8. **`prompts/source/layers/local-overrides/zh-tw/system_prompt.md`** — 11 個 op
9. **`prompts/source/layers/local-overrides/zh-tw/injection_protocol_resolver.md`** — 4 個 op
10. **`prompts/source/layers/local-overrides/zh-tw/injection_protocol_single.md`** — 3 個 op
11. **`prompts/source/layers/local-overrides/en/...`** — 平行 zh-tw

**Layer dir 不必齊全規約:** narrator 在兩個 layer dir 都不出現(完整繼承 base)。
