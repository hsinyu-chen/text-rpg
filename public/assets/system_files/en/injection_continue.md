> User input for this turn:
```
{{USER_INPUT}}
```
## User Input Format
`<Continue>`

## Processing Rules
"Continue" means the protagonist **maintains their current action or does nothing**, awaiting story progression. Please:
- **STRICTLY PROHIBITED**: Do NOT repeat or rephrase the previous plot segment. You MUST produce **entirely new narrative progress**.
- Refer to `# Thinking (CoT) Mode Guidelines` to execute full thinking checklist.
- Advance the world timeline: NPCs act, environment changes, events unfold.
- Trigger random events or NPC-initiated interactions as appropriate.

## This Turn Reminders
- Strictly execute **World Reaction Calculation**.
- **PROHIBITED**: System notifications like "[System Notification: ...]" in the story.
- All setting reveals must blend naturally into narrative and dialogue.
- **[State Synchronization Rule]**: Knowledge Base (KB) files represent static records at the "start of this ACT". The **Current Truth** = `KB Files` + accumulated changes in `character_log`, `inventory_log`, `quest_log`, and `world_log` **AFTER the `--- ACT START ---` marker**. **Under this command, do NOT attempt to request "file updates" in your response; file contents are fixed historical records.**
