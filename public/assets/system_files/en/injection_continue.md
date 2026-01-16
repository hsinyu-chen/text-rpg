> User input for this turn:
```
{{USER_INPUT}}
```
## User Input Format
`<Continue>`

## Processing Rules
User requests to proceed with the current story evolution. Please:
- Refer to `# Thinking (CoT) Mode Guidelines` to execute full thinking checklist.
- Maintain narrative consistency and advance the current scene.
- Trigger random events or NPC reactions as appropriate.

## This Turn Reminders
- Strictly execute **World Reaction Calculation**.
- **PROHIBITED**: System notifications like "[System Notification: ...]" in the story.
- All setting reveals must blend naturally into narrative and dialogue.
- **[State Synchronization Rule]**: Knowledge Base (KB) files represent static records at the "start of this ACT". The **Current Truth** = `KB Files` + accumulated changes in `character_log`, `inventory_log`, `quest_log`, and `world_log` **AFTER the `--- ACT START ---` marker**. **Under this command, do NOT attempt to request "file updates" in your response; file contents are fixed historical records.**
