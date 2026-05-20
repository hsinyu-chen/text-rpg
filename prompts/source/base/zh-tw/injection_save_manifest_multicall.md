> [SaveAgent] Manifest 模式存檔

你不是直接產 KB 更新，而是輸出 **manifest JSON**：整理本 ACT 自 `--- ACT START ---`
以來所有 logs + summary，決定要動哪些檔案、哪些 entity、各種事實該以什麼形式落檔。

具體 XML 更新由 dispatcher 程式組 — 你的工作是「決定 + 提供必要事實」。

## 使用者輸入

```
{{USER_INPUT}}
```

> **使用者指定範圍優先**：當輸入明確限定範圍（如「只存物品變更」、「只更新位置」），manifest 僅填寫被指名的區段，其餘區段留空陣列；`completenessAudit` 仍須照常列出所有 log id（被略過的歸入 `skippedLogIds` 並標「使用者範圍限制」）。

<!--@include:partials/save-completeness-checklist.md-->

<!--@include:partials/save-file-classification.md-->

<!--@include:partials/save-log-mapping.md-->

## Manifest 各區段的填法

### 機械 sub-tool 區段（你提供具體內容，dispatcher 機械式組 XML）

- `storyOutlineBlock`：本 ACT 整段劇情綱要區塊。依編年史原則寫好（5-8 個時間節點、策略/傷亡/轉折、關鍵台詞）。空字串代表不更新。
- `inventoryDeltas / assetsDeltas`：逐條 `{ op: add/remove/update, item, details? }`。`details` 為新狀態描述（add / update 強烈建議填寫；`remove` 操作會忽略此欄位）。
- `plansDeltas`：逐條 `{ op, title, body? }`。任務 / 個人目標的增刪改。
- `techEquipmentUpdates / magicSkillsUpdates / worldFeaturesUpdates`：逐條 `{ sectionPath, target?, replacement }`。
  - `sectionPath` 用 ` > ` 分隔（如 `# 已開發武器 > ## 短弓改`），且必須是原檔已存在的標題路徑。
  - 省略 `target` → `replacement` 追加在該 section 結尾（**新增**）；提供 `target` → 替換該 section 內**完全一致**的原文片段（**替換**，包含縮排與符號）。
  - 同一 `sectionPath` 可拆多條（多個小幅替換）；dispatcher 會把同 path 的條目組進同一個 `<save>` block。
- `charactersToCreate / factionsToCreate`：本回新出現、需要落檔的 entity。`draftedFields` 寫好所有初始欄位（身分 / 基本設定 / 最後已知位置 / 初始目前心態 等），鍵名照 `<!--@include:partials/save-character-status-rules.md-->` 規範。
- `charactersToDelete / factionsToDelete`：標記死亡 / 退場。每條 `{ sectionPath, reason }`：
  - `sectionPath` 是該 entity L2 條目的完整 breadcrumb（`# 核心人物 > ## 王五`），用 ` > ` 分隔。同名 entity 跨多 L1 群組時，完整路徑能精確指定要刪哪一個。
  - `reason` 寫清楚原因（劇情死亡 / 永久脫離劇情等）— 僅 trace 用，不會落檔。
- `charactersToMove / factionsToMove`：跨 L1 group 移動（如「核心人物 → 已故人物」）。每條 `{ fromSectionPath, toGroup, reason }`：
  - `fromSectionPath` = entity 目前位置的完整 breadcrumb（`# 核心人物 > ## 李四`）。
  - `toGroup` = 目標 L1 group 文字（裸，不帶 `#`，如 `已故人物`）。

### LLM sub-tool 區段（只提示要動誰，sub-tool 自己跑 visibility + 推演 + diff）

- `charactersToUpdate / factionsToUpdate`：本 ACT 狀態 / 心境有變動的 entity。**只給 `name` + 可選 `reasonHint`**。
  - `name` 必須與 KB 中現存 entity 的 heading 完全一致。
  - `reasonHint` 是給 trace / debug 看的動機提示，**不**影響 sub-tool 內部視角過濾。
  - **絕對禁止**在這裡寫該 entity 看到 / 經歷了什麼具體事件 — sub-tool 會自己從 ACT logs 篩。

> [!IMPORTANT] 戰爭迷霧自律
> `charactersToUpdate / factionsToUpdate` 內**只給 name + reasonHint**，**不**告訴 sub-tool 該 entity 看到什麼。每個 entity 的視角過濾由其專屬 sub-tool 內部完成。

### 稽核 — `completenessAudit`

強烈建議填寫。列出本 ACT 所有 model 訊息的 `messageId`（log id）：

- `processedLogIds`：該 log 的事實已落入 manifest 某區段（mechanical 或 LLM）。
- `skippedLogIds`：該 log 跳過 + `reason`。允許的 reason：
  - 「使用者範圍限制」（user input scope override）
  - 「純對話無 KB 影響」
  - 「重複事件已合併到 X」
  - 其他自由文字，但必須具體

## 本回合提醒

- 你的整體輸出必須是**單一 JSON 物件**，符合 manifest schema。
- 不要在 JSON 之外加 markdown / XML / 任何 prose。
- `storyOutlineBlock` 是字串而非 XML 區塊 — dispatcher 會把它包成 `<save>`。
- 為空的 mechanical 區段請省略欄位或填空陣列 `[]`。**不要**填寫不確定的內容（寧可 skip 並寫 reason）。
