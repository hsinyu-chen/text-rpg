# prompts/ — build pipeline & slot syntax

This folder holds the **source** for every system / injection prompt the engine
loads at runtime. `npm run prompts:build` composes them into
`public/assets/system_files/{en,zh-tw}/...` (gitignored — never edit there).

```
prompts/
├── source/
│   ├── base/                 # invariant content, one folder per language
│   │   ├── en/<file>.md
│   │   └── zh-tw/<file>.md
│   └── layers/               # per-profile overrides composed onto base
│       ├── cloud-overrides/<lang>/<file>.md
│       └── local-overrides/<lang>/<file>.md
└── tool/
    ├── variants.config.ts    # which base + which layers per output variant
    ├── build-prompts.ts      # CLI entry — `npm run prompts:build`
    ├── parser.ts / composer.ts / renderer.ts / pipeline.ts
    └── .manifest.json        # generated record of every output file
```

## Variants

`variants.config.ts → variants` maps a variant key to `{ base, layers }`. Two
variants per language ship today:

| variant key      | base   | layers              | output                                       |
| ---------------- | ------ | ------------------- | -------------------------------------------- |
| `en/default`     | `en`   | `cloud-overrides`   | `public/assets/system_files/en/`             |
| `en/local`       | `en`   | `local-overrides`   | `public/assets/system_files/en/profiles/local/` |
| `zh-tw/default`  | `zh-tw`| `cloud-overrides`   | `public/assets/system_files/zh-tw/`          |
| `zh-tw/local`    | `zh-tw`| `local-overrides`   | `public/assets/system_files/zh-tw/profiles/local/` |

The runtime's active **prompt profile** picks which generated folder to load.

## Two file modes — passthrough vs slotted

`variants.config.ts → per_file` declares each filename as either passthrough or
slotted. Both modes share the same base directory; the difference is how the
build pipeline treats them.

- **Passthrough (`{ passthrough: true }`)** — base file is copied verbatim to
  the output. **Layer files for this filename are IGNORED**, no composition
  happens, no slot syntax is recognized. Use this when a file has no
  per-profile divergence.
- **Slotted (omitted from `per_file`, or `{ passthrough: false }`)** — the
  pipeline parses the base + each layer file for `<!--@slot:...-->` regions
  and composes them.

**Passthrough is a configuration choice, not a technical limit.** If you need
per-profile divergence on a currently-passthrough file, remove its entry from
`per_file` and add slot markers — see the example below.

## Slot syntax

In a **base file**, wrap a region that may be overridden:

```md
<!--@slot:slot-id-->
default body content (can be empty for an extension point)
<!--@end-->
```

Rules:
- `slot-id` matches `/^[a-z][a-z0-9-]*$/`; unique per file.
- Slots cannot nest, cannot cross a code-fence boundary.
- Any `<!--@...-->` anchor outside a recognized slot tag is a parse error
  ("unknown anchor"). Don't use that comment prefix for normal comments.

In a **layer file** (`prompts/source/layers/<layer>/<lang>/<same-filename>.md`),
mirror the slot tag with a replacement body:

```md
<!--@slot:slot-id-->
replacement body
<!--@end-->
```

- Non-slot text in a layer file is ignored (warning if non-whitespace).
- Default op is `content-replace`. Other ops via `op="..."` attribute on the
  opening tag (see `prompts/tool/types.ts` `OP_KINDS`):
  - `content-prepend` / `content-append` — additive
  - `heading-replace` — replace the leading heading line
  - `full-replace` — replace the slot region including its surrounding heading
  - `remove` (or attribute `remove` without `op=`) — drop the slot entirely
- A layer slot-id with no matching slot in base → parse error.
- A layer file under a layer dir that no base file matches → "orphaned layer
  file" warning.

## Example: opening a passthrough file to per-profile divergence

Suppose `injection_xyz.md` is passthrough and you want to add a local-only
extra rule under one section.

1. In `prompts/tool/variants.config.ts`, **remove** the file's entry from
   `per_file` (or change it to `{ passthrough: false }`).
2. In `prompts/source/base/{en,zh-tw}/injection_xyz.md`, mark an extension
   point in the relevant section — typically an empty slot near the end of
   that section:
   ```md
   ... existing base content ...
   <!--@slot:xyz-extra-->
   <!--@end-->
   ... rest of base ...
   ```
3. In `prompts/source/layers/local-overrides/{en,zh-tw}/injection_xyz.md`,
   create the layer file with the slot filled:
   ```md
   <!--@slot:xyz-extra-->
   the local-only addition
   <!--@end-->
   ```
4. Run `npm run prompts:build`. The default variant produces an empty-slot
   output (slot effectively invisible); the local variant produces output
   with the addition. Diff the two generated files to confirm.

The cloud profile (`cloud-overrides`) gets no override for that slot, so its
output is identical to base. Either layer can override the same slot
independently — the variant config picks which layer applies.

## Validation

`npm run prompts:check` runs the same pipeline but compares output against
`.manifest.json` instead of writing files — used in CI to catch unintended
drift. After hand-editing the source files, run `prompts:build` to refresh
both `.manifest.json` and the generated outputs in `public/assets/`.

## Don't

- Don't edit `public/assets/system_files/**/*.md` — those are generated. Edits
  vanish on the next build.
- Don't claim "passthrough means I can't override" — flip the config and add
  slots if you need divergence.
- Don't add `<!--@anchor:...-->` comments for purposes other than slots — the
  parser treats every `<!--@...-->` outside a known slot tag as an error.
- Don't bake concrete examples or change history into LLM-facing prompts —
  base/layer content is shipped to the model. Comments-about-the-prompts go
  here in this README, not inside `injection_*.md`.
