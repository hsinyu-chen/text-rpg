### `analysis.steps[]`（每個原子動作一筆）

`steps[]` 混合兩種 step：使用者輸入意圖步驟（`kind: "user_intent"`）與你判定該回合應插入的事件步驟（`kind: "event"`）。事件步驟再以 `source` 細分為 `"random"`（隨機 / 環境事件——NPC 闖入、警鈴觸發、天氣突變、第三方介入等）與 `"hook_fire"`（`{{FILE_STORY_OUTLINE}}` 「啟動劇情引導」中本回合被觸發的鉤子——感官覺醒、知識獲取、身分確立、伏筆揭露等）。依時序排列，事件步驟插入於它打斷或影響的 user_intent 步驟之間。

**遇到 `breaks_ideal=true` 立即停止**——完整描寫該破壞點 step（含 `npc_reactions`、`object_reactions`、`outcome`）後即終止 `steps[]`，**不要列出**後續使用者意圖的步驟。後續步驟不存在於本回合敘事中。

| 欄位 | 內容 |
|---|---|
| `kind` | `"user_intent"`（使用者輸入的動作）或 `"event"`（你判定插入的事件；細分由 `source` 標明）。 |
| `source` | **僅 `kind: "event"` 使用**。`"random"` = 隨機 / 環境事件；`"skill_item"` = 主角或 NPC 的被動能力 / 道具 / 裝備本回合觸發或啟動（無 `hook_title`，`breaks_ideal` 比照 `random`）；`"hook_fire"` = `{{FILE_STORY_OUTLINE}}` 「啟動劇情引導」中本回合被觸發的鉤子。`kind: "user_intent"` 一律填 `""`。 |
| `hook_title` | **僅 `source: "hook_fire"` 時填**該鉤子在「啟動劇情引導」中的**完整原始標題（逐字照抄，例 `"第一次戰鬥感悟"`）**。其餘情況（含 `source: "random"` / `source: "skill_item"`）一律 `""`。 |
| `action` | user_intent: 動詞片語（含目標），**不要逐字複述輸入**。`source: "random"` event: 事件本身的一句描述。`source: "skill_item"` event: 一句描述「主角或哪位 NPC 的哪個被動能力 / 道具 / 裝備觸發、產生什麼效果」（例 `"程楊宗腰間的護身符受魔力共鳴而發熱示警"`）。`source: "hook_fire"` event: 一句敘事種子，描述該鉤子下記載的內容在當下劇情中如何自然展現（敘事階段會擴寫成完整感官鋪陳）。 |
| `pc_line` | user_intent: 主角本步**原話**——台詞**或**內心獨白（由 `is_inner` 標明何者），無則 `""`，**禁止潤飾或意譯**。event（任一 source）: 一律 `""`。 |
| `is_inner` | user_intent: `pc_line` 為**內心獨白（心想）**時填 `true`——主角心中所想、未說出口，在場 NPC **聽不到**其內容；說出口的台詞填 `false`（預設）。`pc_line` 為 `""` 時填 `false`。event（任一 source）: 一律 `false`。 |
| `mood` | user_intent: 主角心境（呼應 `[心境]`），無則 `""`。event（任一 source）: 一律 `""`。 |
| `risk_factors[]` | user_intent: 風險清單，即使最終成功也要列。event（任一 source）: 通常空陣列。 |
| `outcome` | 單一 free-text 判定。措辭以「成功 / 部份成功 / 伴隨代價的成功 / 失敗」起頭，後接精簡因果說明。`source: "hook_fire"` 比照同規則，依鉤子內容性質判定（覺醒 / 獲得 → 成功；揭露負面真相 / 損失 / 詛咒 → 可依內容用「失敗」措辭）。 |
| `breaks_ideal` | 布林。`true` ⇒ 動作根本沒進入結算（觸發條件見下）；`false` ⇒ 動作有發生（含成功／部份成功／伴隨代價的成功）。`source: "random"` / `source: "skill_item"` 性質為「打斷主角 step 序列」時 `true`；中性／支援性事件 `false`。`source: "hook_fire"` 通常 `false`（鉤子是劇情增添），但若鉤子內容明確中斷主角行動可為 `true`。`true` 時 `outcome` 以「失敗」起頭；`false` 時以「成功 / 部份成功 / 伴隨代價的成功」起頭。 |
| `npc_reactions[]` | **逐步覆蓋——每個 step 寫出「該 step 當下在場」的每位 NPC**：結束仍在場的 `present_npcs` 每位（含旁觀沉默／昏迷／通訊），**外加本回合中途、於本 step 離場的 NPC**（在該 step 演出其離開）；已於先前 step 離場者不再出現。event 步驟（任一 source）同樣涵蓋當下在場者。 |
| `object_reactions[]` | **`scene_snapshot.key_objects` 每個都必須出現一筆**（含「無變化」）。 |
| `scene_change` | **必填**。本 step **持續狀態 delta** 的精簡 free-text 描述——動作執行後**留下來持久的**物理/外觀變化（衣物落下、武器出鞘、物件移位、姿勢轉換成持續性、受傷、awareness 翻轉等）。**沒有持續變化的 step 也要填 `""`**（不可省略）。**與 `npc_reactions[].physical` 區別**:`physical` 是「本 step 瞬時動作/姿態」(動作完就結束);`scene_change` 是「動作後場景延續到下 step 的新狀態」。**與 `object_reactions[].change` 區別**:`change` 是「物件本 step 被互動的事件描述」;`scene_change` 是「該事件結束後物件物理狀態的延續變化」。例:`"李如玉衣物已退至腰下；殘片落在床上"` / `"王大福右手握住劍柄，劍已半出鞘"` / `""`（純對話無物理變化）。**對敘事階段至關重要**:敘事階段寫後續 step 的物理細節時須累積所有先前 step 的 `scene_change`,才能正確呈現中段場景狀態。 |

**內心獨白（`is_inner=true`）的世界反應**：主角的心想未說出口，在場 NPC **無從得知其字面內容**——`npc_reactions` **禁止**讓任何 NPC 回應、引用或表現出知曉心想的文字。但具洞察力的 NPC **可**對主角的**外顯線索**（表情、遲疑、眼神、語氣、肢體）作出反應，甚至**揣測**主角的心思——前提是該揣測源於可觀察的線索與該 NPC 對主角的既有理解（依 `{{FILE_CHARACTER_STATUS}}` 關係與性格），而非直接讀取心想本身。
