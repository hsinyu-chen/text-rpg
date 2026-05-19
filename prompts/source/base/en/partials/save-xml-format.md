### XML Tag Format

#### 1. `<save file="Filename" context="Path">`
Defines target file and node path:
- **`file`**: Full filepath (e.g., `{{FILE_CHARACTER_STATUS}}`)
- **`context`**: **MUST** be an **existing** header string from the original file, including `#`, spaces, and `**` bold markers.
- Use ` > ` to separate levels (e.g., `# Core Characters > ## Cheng Yangzong`).
- Set to empty string `""` if targeting the file root.
- **FORBIDDEN** to use non-existent/new headers in `context`

#### 2. `<update>`
Wraps a single atomic update. A `<save>` can contain multiple `<update>` tags.

#### 3. `<target>` [Optional]
The original content to be replaced. MUST match the file content **exactly** (including indentation and symbols).
- **Continuity**: Must be a **complete and continuous** block from the file.
- **Efficiency**: Should contain the **minimum scope** needed for the change.
- If omitted, content is **Appended** to the end of the `context` node.
- **Reference-template exclusion**: Content inside any `## Save Format` code fence is documentation for the XML format itself, NOT real data. It MUST NOT appear as `<target>` and MUST NOT be edited. When adding new entries to such files, use the Add operation (omit `<target>`) targeting a sibling section of `## Save Format` under the file root.

#### 4. `<replacement>`
The new content.

### Operation Types
- **Replace**: Provide both `<target>` and `<replacement>`.
- **Add**: Provide only `<replacement>` (Appends to node).
- **Delete**: Provide only `<target>` with no `<replacement>` (or empty `<replacement></replacement>`).
- **Full File Replace**: `context=""` and no `<target>`.

### Correct Format for Adding New Entries
When adding a new header entry (e.g., new character), `context` should point to the **parent node** (an existing header). The new header MUST be inside `<replacement>`:
```xml
<!-- ✓ Correct: Adding character under existing category -->
<save file="{{FILE_CHARACTER_STATUS}}" context="# Core Characters">
  <update>
    <replacement>
## New Character Name
- **Identity**: xxx
    </replacement>
  </update>
</save>
```

### Example
```xml
<save file="{{FILE_CHARACTER_STATUS}}" context="# Core Characters > ## Cheng Yangzong">
  <update>
    <target>
      - **Last Known Location**: Office
    </target>
    <replacement>
      - **Last Known Location**: Restaurant (08:30)
    </replacement>
  </update>
</save>
```
