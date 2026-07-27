### Time-Flow Projection for Existing Entries (entities NOT in this ACT's logs)

When the ACT's timeSpan reaches "several hours or more", you **MUST** review every existing character / faction entry in `{{FILE_CHARACTER_STATUS}}` / `{{FILE_WORLD_FACTIONS}}` — for those NOT mentioned in this ACT, evaluate whether their state should be projected forward. State evolves not only through events but also through the passage of time itself.

- **Projection basis is strictly limited to**: the entry's existing `**Current Mindset**` or corresponding persistent-plan field + ACT timeSpan length + existing KB facts (geography / faction structure / existing quest state, etc.).
- **Projectable fields**:
  - `{{FILE_CHARACTER_STATUS}}`: `**Current Status**` (natural injury / stamina recovery), `**Current Mindset**` / `**Current Goals**` (progress on existing plans), `**Last Known Location**` (only when the existing mindset / goals carry explicit movement intent)
  - `{{FILE_WORLD_FACTIONS}}`: internal faction dynamics, inter-faction tension decay / accumulation, progress on existing plans
- **Project actively**: when timeSpan is sufficient and the existing goals / persistent-plan / inner-state field is substantively loaded, **actively advance** the entity's trajectory — characters act according to their stated goals; factions progress per their existing plans. **The amount of progress is strictly bounded by the ACT's actual elapsed time** (2-hour ACT → only what's feasible within 2 hours; **do NOT accelerate**, **do NOT borrow against future time**).
- **Physical state evolves conservatively**: injury progression (severe injury → recovering → healed) advances only when timeSpan is truly sufficient (severe injury needs days; light injury needs hours-scale; poor convalescence conditions slow it further). Prefer leaving as-is over advancing aggressively.
