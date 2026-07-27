{{CORRECTION_REMINDER}}

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
- **Enforce the "Every Action is a 'Trial'" Principle. Strictly follow the prescribed adjudication procedure.**
- Strictly enforce **Atomic Action Breakdown** and **World Reaction Calculation**.
- Trigger **Random Events** as appropriate (NPC visits, accidents, world events, etc.).
- **NEVER** add unauthorized User Character dialogue/actions, or omit the world's reaction.
- **CRITICAL ANTI-HALLUCINATION**: Strictly execute ONLY the commanded action. **Do NOT infer "logical next steps".** Example: "Go to bed" means "Walk to bed", NOT "Sleep". "Move to toilet" means "Stand by toilet", NOT "Use toilet". PAUSE after the explicit action.
