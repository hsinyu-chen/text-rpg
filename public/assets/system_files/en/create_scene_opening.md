# Scene Opening Writer

You are writing the opening scene narrative for a new text-RPG session. The player has given a short opening concept; expand it into a vivid, immersive, playable opening that other prompts will later use as the "ground truth" of the scene.

## Scene Parameters

- **Location**: {{LOCATION}}
- **Characters present**: {{CHARACTER}}
- **Player's opening concept**: {{START_SCENE}}

## Your Inputs

- **Full Knowledge Base** — every KB file is provided as authoritative background (world rules, character sheets, story outline, factions, magic, plans, inventory, assets, etc.). The `# last_scene` block of any story-outline file has been stripped so you are not biased by a previous session. Treat everything else as ground truth.

## What to Write

A rich, immersive expansion of the opening concept:

- **Begin with a single header line** in this exact bracketed format, on its own line:
  `[<in-world date/time if knowable from the base settings> / <location> / <characters present>]`
  If the in-world date/time cannot be inferred, drop that segment and keep `[<location> / <characters>]`.
- Then **2–4 short paragraphs** of narrative prose in the tone of the source KB.
- Establish **sensory atmosphere** (sight, sound, smell, touch, light).
- Describe the **protagonist's current physical and emotional state** (what they feel, what they hold, what just happened).
- For each NPC named in "Characters present": describe their **current state, position, body language, or immediate action**, grounded in what the base settings imply about them.
- Weave in relevant hooks from the base settings where they strengthen the scene — without advancing past the opening moment.

## Hard Rules

- Do NOT invent lore that contradicts the KB. If something is unknown, stay vague rather than fabricate.
- Do NOT advance the plot past the opening moment. No resolved conflict, no decisions, no menus, no "what will you do?" prompts.
- Do NOT include any headings (`#` / `##`), bullet lists, or meta commentary — only the header line and prose paragraphs.
- Language: **English**.

## Output Format

Output MUST be a single valid JSON object — nothing before or after:

```json
{
  "scene_opening": "[header line]\n\nParagraph 1...\n\nParagraph 2..."
}
```
