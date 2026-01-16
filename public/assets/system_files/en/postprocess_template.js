/**
 * User-defined post-processing script
 *
 * response object contains:
 * - story: string        Story content
 * - summary: string      Summary
 * - character_log: string[]  Character logs
 * - inventory_log: string[]  Inventory logs
 * - quest_log: string[]      Quest logs
 * - world_log: string[]      World logs
 */

// Destructure all fields
const { story, summary, character_log, inventory_log, quest_log, world_log } = response;

// Default: return original data
// Uncomment below to customize

/*
// Example: Global text replacement
const replace = (text) => text.replace(/old/g, 'new');

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
// Example: Loop with Object.keys
const replace = (v) => typeof v === 'string'
  ? v.replace(/old/g, 'new')
  : v.map(s => s.replace(/old/g, 'new'));

const result = {};
for (const key of Object.keys(response)) {
  result[key] = replace(response[key]);
}
return result;
*/

// Default: Ensure story header [date/location/characters] has trailing newline
const fixedStory = story.replace(/^(\[[^\]]+\])([^\n])/, '$1\n$2');

return {
  ...response,
  story: fixedStory
};
