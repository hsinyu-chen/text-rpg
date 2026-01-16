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
- Strictly check for events within the time interval.
- Stop if event occurs; jump only if empty.
- **PROHIBITED**: System notifications like "[System Notification: ...]" in the story.
