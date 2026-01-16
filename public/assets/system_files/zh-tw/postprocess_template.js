/**
 * 使用者自訂後處理腳本
 *
 * response 物件包含以下欄位：
 * - story: string        故事內容
 * - summary: string      摘要
 * - character_log: string[]  角色日誌
 * - inventory_log: string[]  物品日誌
 * - quest_log: string[]      任務日誌
 * - world_log: string[]      世界日誌
 */

// 解構取得所有欄位
const { story, summary, character_log, inventory_log, quest_log, world_log } = response;

// 預設：直接返回原始資料
// 取消下方註解開始自訂

/*
// 範例：全域文字替換
const replace = (text) => text.replace(/當前/g, '目前');

return {
  story: replace(story),
  summary: replace(summary),
  character_log: character_log.map(replace),
  inventory_log: inventory_log.map(replace),
  quest_log: quest_log.map(replace),
  world_log: world_log.map(replace)
};
*/

/*
// 範例：Object.keys 迴圈
const replace = (v) => typeof v === 'string'
  ? v.replace(/當前/g, '目前')
  : v.map(s => s.replace(/當前/g, '目前'));

const result = {};
for (const key of Object.keys(response)) {
  result[key] = replace(response[key]);
}
return result;
*/

// 預設處理：確保 story 開頭的 header [日期/地點/人物] 後有換行
const fixedStory = story.replace(/^(\[[^\]]+\])([^\n])/, '$1\n$2');

return {
  ...response,
  story: fixedStory
};
