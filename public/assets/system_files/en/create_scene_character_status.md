### Current file: Character Status (character sheets, party roster, NPC dossiers)

Output a scene-focused character roster that preserves the original file's structure (headers, order, formatting conventions). Apply the following tiered rule to every character in the file:

#### Tier A — Full preservation (copy each character's ENTIRE entry verbatim)

- The **player character** (protagonist / POV character), always.
- Every character named in "Characters": **{{CHARACTER}}**.
- Every character with a **close relationship** to any Tier-A character — friends, lovers, spouses, siblings, parents / children / other family, classmates / coworkers, mentors / disciples, direct subordinates, immediate superiors, party companions, notable rivals or antagonists of the protagonist. Relationship is inferred from the source file itself.

For Tier A: do NOT paraphrase, shorten, or "summarize" their sheets. Stats, backstory, traits, equipment lines, quirks, sub-entries — everything stays.

#### Tier B — Single-line summary (never delete entirely)

Every other character in the file must stay, but their entry is compressed to **one concise line** keeping the character's name/identifier. Example format:

```
### Character Name — one-sentence description of role and current state.
```

The new session still needs to recognize these people when they are referenced later.

#### Other rules

- Preserve section order and structural conventions of the original file (category headers like "Main Party", "Allies", "Antagonists", etc.).
- Do NOT advance any character's state past the opening scene.
