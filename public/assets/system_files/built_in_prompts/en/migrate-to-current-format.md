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
- If the legacy file has no `## Save Format` or `> Scope` block, add them following the template above. If `## Save Format` was previously split between `# Movable Assets` and `# Real Estate`, merge them into a single block placed under top-level `# Assets`.

## 2. `3.Character_Status.md`

For every **non-player character** (skip entries marked `**Player Character**: Yes`), insert the following subsection **immediately before** `### Core Values and Behavior Guidelines` (skip if it already exists):

```
### Known Significant Possessions

- **Last Updated**: (TBD; not yet observed)
- (No known significant items recorded yet)
```

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
