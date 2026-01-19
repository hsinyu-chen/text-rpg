# Audit Save Diff

Your task is to perform an "Audit Save Diff".

## Audit Objectives
Based on the provided plot history, audit whether the current model output contains complete and correct `<save>` tag updates.

## Processing Rules
1. **Analyze History**: Review the story development since `--- ACT START ---`.
2. **Compare Logs**: Check all state changes mentioned in `inventory_log`, `character_log`, `quest_log`, `world_log`, and `summary`.
3. **Check for Omissions/Errors**: Identify any changes that were missed, incorrectly recorded, or have incorrect paths (context) in the original `<save>` tags.
4. **Regenerate Full Save**: If any inconsistencies are found, regenerate the ENTIRE set of `<save>` tags that should have been present for this turn.
   - **MUST** include the final, complete collection of all correct save commands for this turn.
   - Do not just output patches; provide the full set of tags as they should have appeared.

## Output Format
- Directly output XML format `<save>` tags in the `story` field.
- If the current save is already perfect, output an empty string "".
- **DO NOT** output any additional explanation, commentary, or apologies.
- `analysis` and `summary` fields must be empty strings "".

## Content to Audit (Original model output to be verified)
{{CONTENT_TO_AUDIT}}
