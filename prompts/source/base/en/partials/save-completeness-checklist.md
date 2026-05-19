### Mandatory Completeness Checklist
Before outputting, verify you have processed:
- [ ] **ALL** `inventory_log` entries → corresponding file updates
- [ ] **ALL** `character_log` entries → `{{FILE_CHARACTER_STATUS}}` updates
- [ ] **ALL** `quest_log` entries → `{{FILE_PLANS}}` updates  
- [ ] **ALL** `world_log` entries → corresponding file updates
- [ ] **ALL** state changes mentioned in `summary` logs → reflected in files
- [ ] Story Outline updated with current ACT events
- [ ] **Newly generated people/things/location details from `Look`/`Observe` actions** → persisted to the corresponding files

**If ANY log entry lacks a corresponding `<save>` update, your output is INCOMPLETE and INVALID.**
