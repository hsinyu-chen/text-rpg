Please migrate this world book to the latest format. Process each file. **All changes MUST go through tool calls** (getFileOutline / readSection / replaceSection / insertSection / searchReplace) — do not merely describe the changes.

## 1. `4.Assets.md`

The final structure must match this template:

````markdown
# Assets

> **Scope**: This file records ONLY cash, real estate, and base layouts **owned by the protagonist**. Each base layout MAY include **long-term items deposited at that location** (distinct from `9.Inventory.md`: Inventory is for carried items, this file is for non-carried storage). **NPCs' and companions' personal assets** belong in `3.Character_Status.md` under that character's entry, NOT here.

## Save Format

```
# Movable Assets

* **Current Cash**: **[Amount] [Currency]** (As of Act.[Number])

# Real Estate

## [Base Name]

* **Location**: [Location]
* **Description**: [Detailed Description]
* **Layout**:
    * **[Floor]**:
        - **[Room Name]**: [Function and Content; may list long-term items deposited here]
```

---

# Movable Assets

(actual data; write "None" if absent)

---

# Real Estate

(actual data; write "None" if absent)
````

What to fix:
- Drop intermediate headings such as `## Initial Assets` and `## Initial Real Estate`; move their content directly under the corresponding H1.
- **Do NOT modify the actual data** (amounts / base layouts) — only adjust structural headings.
- The `> Scope` blockquote and `## Save Format` block must be added **idempotently**: before inserting, use `readSection` on the top of `# Assets` or `grep` for `Scope`/`Save Format` to confirm the block does **not already exist**. If a similar block is already present (even with slightly different wording), treat it as done and skip — do NOT add a second copy. If the existing block is genuinely outdated or wrong, rewrite it with `replaceSection` / `searchReplace`, never `insertIntoSection` on top of it.
- If `## Save Format` was previously split between `# Movable Assets` and `# Real Estate`, merge them into a single block placed under top-level `# Assets` (delete the old copies first, then insert the merged block in the correct position).

## 2. `3.Character_Status.md`

For every **non-player character** (skip entries marked `**Player Character**: Yes`), ensure a `### Known Significant Possessions` subsection exists **immediately before** `### Core Values and Behavior Guidelines`. Even if the NPC already has this subsection — or already looks fully migrated — **still read the entire entry** and check whether any significant possessions remain stranded in other fields; if so, fold them in. Do NOT skip the scan just because the subsection exists.

**Scan scope** — items can hide anywhere, but common hot spots:
- Direct fields: `Possessions`, `Equipment`, `Carried Items`, `Gear`, etc.
- Sub-fields under `Personal Details`: `Attire`, `Appearance`, `Disguise` — rings, necklaces, weapons, communication devices, keepsakes mentioned here.
- Prose paragraphs in `Background`, `Current Mindset`, `View of [character]`, etc., where items get mentioned in passing (e.g. "always carries her father's dagger at her waist").

**Criteria for "significant possessions"** — include any of:
1. Named items (with a proper name, e.g. "Hyacinth Ring", "Bee Sting", "Trinity Ring").
2. Items with emotional or relational meaning (gifted by whom, symbolizes what).
3. Weapons, communication / magic devices, or items that shape the character's actions or identity.

**Do NOT include**: ordinary clothing (uniforms, socks, dresses with no special meaning), hairstyles, or body descriptions.

**Subsection format**:

```
### Known Significant Possessions

- **Last Updated**: (As of Act.[Number], compiled from existing character card description)
- [Item Name]: [one-line summary of source / purpose / meaning]
- ...
```

Use the placeholder content ONLY if a careful read genuinely turns up nothing:

```
### Known Significant Possessions

- **Last Updated**: (TBD; not yet observed)
- (No known significant items recorded yet)
```

**Clean up the source fields after migrating** (the goal here is consolidation, not duplication):
- For **dedicated fields** (e.g. `Possessions or Equipment: Bee Sting, Communication Device`): remove the migrated entries; if the field is left empty, drop the field itself.
- For **prose fields** (Attire / Appearance / Disguise / Background, etc.): rewrite to remove the item's description while keeping the surrounding tone and any unrelated details (e.g. "On her left ring finger she wears the 'Hyacinth Ring' Yusei gave her, symbolizing 'a lifetime'" → drop the sentence; the item moves to the new subsection with the meaning "gifted by Yusei, symbolizes 'a lifetime'" preserved in its summary).
- If a rewrite would leave the prose broken or strip away important unrelated context, list the sentence in the final report for user judgment instead of forcing the deletion.

**Never add this subsection to the protagonist's entry.**

## 3. `9.Inventory.md`

New rule: this file records ONLY items **owned by the protagonist** that are **carried (on-person)**. Review the content:
- If any entries describe an NPC's personal items (e.g. "Lita's necklace"), move them into that NPC's `### Known Significant Possessions` in `3.Character_Status.md` and delete them from this file.
- If any containers represent storage at a base, inn, or third-party safekeeping (e.g. "Home Chest", "Inn Locker"), remove them from this file and write the content under the corresponding base layout in `4.Assets.md` (create the base in `4.Assets.md` if it does not yet exist).
- For ambiguous entries, leave them in place and call them out in the final report so the user can decide.

## Finish

After all migrations are done, call `submitResponse` and report file by file:
- What changed in each file (or that nothing was changed).
- Any ambiguous entries that need a user decision.
