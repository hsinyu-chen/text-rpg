<!--@slot:correction-intro-->
> The previous turn's `<System>` intervention requested a correction:
<!--@end-->

<!--@slot:rerun-rules-->
> 1. You are re-generating the scene for the **same player action**. Discard the previous (faulty) version completely; narrate from the corrected world state.
> 2. The correction above is **top priority**. Any conflicting `character_log`, `inventory_log`, or setting description **must yield to the correction**.
> 3. **Every field (`story`, `*_log`, `scene_header`) must reflect the final corrected state.** The "reason / rule" of the correction lives only in the `correction` field — do not annotate other fields (including logs) with "calibration", "previously was", or any narration of the correction process.
> 4. Do not apologize, explain, or mention "correction" in the prose — to the player, this is simply the correct version of the story.
<!--@end-->
