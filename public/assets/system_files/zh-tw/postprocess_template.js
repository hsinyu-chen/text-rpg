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

// 1. 解構取得所有欄位
const { story, summary, character_log, inventory_log, quest_log, world_log } = response;

// 2. 安全術語替換 (常犯錯且可安全替換的用語)
const safeReplacements = [
  [/當前/g, '目前'],
  [/數據/g, '資料'],
  [/信息/g, '訊息'],
  [/用戶/g, '使用者'],
  [/屏幕/g, '螢幕'],
  [/激活/g, '啟用'],
  [/網絡/g, '網路'],
  [/軟件/g, '軟體'],
  [/硬件/g, '硬體'],
  [/硬盤/g, '硬碟'],
  [/視頻/g, '影片'],
  [/音頻/g, '音訊']
];

let processedStory = story;
let processedSummary = summary;
let processedCharacter = character_log;
let processedInventory = inventory_log;
let processedQuest = quest_log;
let processedWorld = world_log;

const applyReplacements = (text) => {
  if (typeof text !== 'string') return text;

  // Split by <save ... </save> blocks to protect them
  // formatting constraints: <save ... </save>
  const parts = text.split(/(<save[\s\S]*?<\/save>)/gi);

  return parts.map(part => {
    // If it is a save block, return as is
    if (part.trim().toLowerCase().startsWith('<save')) {
      return part;
    }

    // Otherwise apply replacements
    let t = part;
    for (const [pattern, replacement] of safeReplacements) {
      t = t.replace(pattern, replacement);
    }
    return t;
  }).join('');
};

processedStory = applyReplacements(processedStory);
processedSummary = applyReplacements(processedSummary);
processedCharacter = processedCharacter.map(applyReplacements);
processedInventory = processedInventory.map(applyReplacements);
processedQuest = processedQuest.map(applyReplacements);
processedWorld = processedWorld.map(applyReplacements);

// 2. 故事格式修正：確保 story 開頭的 header [日期/地點/人物] 後有換行
// 考慮到開頭可能有 <CREATIVE FICTION CONTEXT> 前綴
processedStory = processedStory.replace(/^(<[^>]+>\s*)?(\[[^\]]+\])([^\n])/, (match, prefix, header, nextChar) => {
  return (prefix || '') + header + '\n' + nextChar;
});

return {
  story: processedStory,
  summary: processedSummary,
  character_log: processedCharacter,
  inventory_log: processedInventory,
  quest_log: processedQuest,
  world_log: processedWorld
};
