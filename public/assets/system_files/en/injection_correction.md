> ⚠️ **This turn is a correction-driven re-run** ⚠️
>
> The previous turn's `<System>` intervention requested a correction:
>
> ```
> {{CORRECTION_TEXT}}
> ```
>
> ## Re-run rules (hard)
> 1. You are re-generating the scene for the **same player action**. Discard the previous (faulty) version completely; narrate from the corrected world state.
> 2. The correction above is **top priority**. Any conflicting `character_log`, `inventory_log`, or setting description **must yield to the correction**.
> 3. The narrator's prose, `*_log` entries, and `scene_header` (if applicable) must all be consistent with the corrected state.
> 4. If the correction touches the protagonist's gear / inventory / status, this turn's `inventory_log` or `character_log` **must** include a `校正` (calibration) entry so the hard fact and the correction note coexist.
> 5. Do not apologize, explain, or mention "correction" in the prose — to the player, this is simply the correct version of the story.
