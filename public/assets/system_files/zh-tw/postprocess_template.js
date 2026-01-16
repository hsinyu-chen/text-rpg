/**
 * 使用者自訂後處理腳本
 * User-defined post-processing script
 *
 * @param {Object} response - AI 回應物件 / AI response object
 * @param {string} response.story - 故事內容 / Story content
 * @param {string} response.summary - 摘要 / Summary
 * @param {string[]} response.character_log - 角色日誌 / Character logs
 * @param {string[]} response.inventory_log - 物品日誌 / Inventory logs
 * @param {string[]} response.quest_log - 任務日誌 / Quest logs
 * @param {string[]} response.world_log - 世界日誌 / World logs
 * @returns {Object} 修改後的 response 物件 / Modified response object
 *
 * @example 全域文字替換 / Global text replacement
 * const replace = (text) => text.replace(/當前/g, '目前');
 * return {
 *   story: replace(response.story),
 *   summary: replace(response.summary),
 *   character_log: response.character_log.map(replace),
 *   inventory_log: response.inventory_log.map(replace),
 *   quest_log: response.quest_log.map(replace),
 *   world_log: response.world_log.map(replace)
 * };
 *
 * @example 使用 Object.keys 迴圈 / Loop with Object.keys
 * const replace = (v) => typeof v === 'string'
 *   ? v.replace(/當前/g, '目前')
 *   : v.map(s => s.replace(/當前/g, '目前'));
 * const result = {};
 * for (const key of Object.keys(response)) {
 *   result[key] = replace(response[key]);
 * }
 * return result;
 */
return response;
