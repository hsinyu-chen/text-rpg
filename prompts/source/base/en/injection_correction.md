> ⚠️ **This turn is a correction-driven re-run** ⚠️
>
<!--@slot:correction-intro-->
> Previous turn's `<System>` correction:
<!--@end-->
>
> ```
> {{CORRECTION_TEXT}}
> ```
>
> ## Re-run rules (hard)
<!--@slot:rerun-rules-->
> 1. Re-generate the scene for the **same player action**. Discard the previous version; narrate from the corrected world state.
> 2. The correction above is top priority; conflicting prior content yields to it.
> 3. All fields (`story`, `*_log`, `scene_header`) must reflect the corrected final state. The reason/rule of the correction lives only in the `correction` field — no calibration markers in other fields.
> 4. Do not apologize or mention "correction" in the prose — this is the correct version.
<!--@end-->
