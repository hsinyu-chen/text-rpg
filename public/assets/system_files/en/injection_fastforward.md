> User input for this turn:
```
{{USER_INPUT}}
```
## User Input Format
`<Fast Forward>Target Time or Location`

## Processing Rules
User wishes to skip ahead to a specific time (e.g., Monday, 3 days later) or location.

**Event Check Process**:
1. Check from current time to target time: Will any "Special Events" occur?
2. Special Events include: NPC visits, Plan progress, conflicts, etc.

**Result Handling**:
- **If NO Special Events**: Jump directly to target time/location. Describe the scene and status upon arrival.
- **If YES Special Events**: **STOP Fast Forwarding** at the moment the event occurs. Describe the event and world reaction in detail. Return control to user.

**Analysis Field Requirements**:
Must detail the check process. Example: "Checking Sat: No events. Checking Sun: Trigger NPC Visit. Stop Fast Forward."

## This Turn Reminders
- **Enforce the "Every Action is a 'Trial'" Principle. Strictly follow the prescribed adjudication procedure.**
- Strictly check for events within the time interval.
- Stop if event occurs; jump only if empty.
- **NO Unauthorized Actions**: During the fast forward (or at the destination), do NOT describe the character doing things they weren't conditioned to do. Just describe the arrival/waiting result.
- Trigger **Random Events** as appropriate (NPC visits, accidents, world events, etc.).
- **NEVER** add unauthorized User Character dialogue/actions, or omit the world's reaction.
- **PROHIBITED**: System notifications like "[System Notification: ...]" in the story.
- All setting reveals must blend naturally into narrative and dialogue.
- **[State Synchronization Rule]**: Knowledge Base (KB) files represent static records at the "start of this ACT". The **Current Truth** = `KB Files` + accumulated changes in `character_log`, `inventory_log`, `quest_log`, and `world_log` **AFTER the `--- ACT START ---` marker**. **Under this command, do NOT attempt to request "file updates" in your response; file contents are fixed historical records.**
