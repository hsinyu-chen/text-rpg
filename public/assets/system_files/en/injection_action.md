> User input for this turn:
```
{{USER_INPUT}}
```
## User Input Format
`<Action Intent>([Mood]Action)Dialogue or Inner Monologue`

## Processing Rules
This is the primary method for the user to drive the plot. You MUST refer to the System Prompt:
- `# Thinking (CoT) Mode Guidelines` - Execute the full thinking checklist.
- `# Interaction Commands & Rules` > `### Writing Process` - Perform narrative deduction.

## This Turn Reminders
- Strictly enforce **Atomic Action Breakdown** and **World Reaction Calculation**.
- **NEVER** add unauthorized User Character dialogue/actions.
- **NEVER** omit the world's reaction.
- **PROHIBITED**: System notifications like "[System Notification: ...]" in the story.
- All setting reveals must blend naturally into narrative and dialogue.
- **[State Synchronization Rule]**: Knowledge Base Files are **OLD INFO**. You MUST merge changes in `character_log`, `inventory_log`, `quest_log`, and `world_log` to calculate the **CURRENT STATE**.
