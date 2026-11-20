# UI guidelines

Harbor lives inside DeepSeek Harness. It shares the document, the theme, the font stack and the user's density setting with the rest of the app, so its job is to look like *the same product*, not a panel bolted on.

## Rules

1. **No literal design values.** No hex colours, no `px` radii, no font sizes outside the kit. Everything resolves through the `--hb-*` tokens declared at the top of `src/client/ui/styles/app.css`, which in turn point at the host's semantic tokens (`--dsw-alias-*`). A value no token can express is a design question, not a CSS shortcut.
2. **One primary action per surface.** Everything else is `secondary` (bordered) or `ghost` (text). Destructive actions are `danger` / `danger-solid` and ask before they run.
3. **Every surface renders one of four states**: content; an empty state that says what to do next; an error note with the cause; or a disabled control that explains itself in a tooltip.
4. **Icons carry no meaning alone.** An icon-only button always has an accessible `label` (used as tooltip and `aria-label`). Icon + text beats icon-only unless it repeats a pattern directly above.
5. **Density**: 32px buttons, 34px text fields, 28px icon buttons (22px in dense toolbars), 12px labels, 13px body. Rows are 28–32px; a two-line row (title + meta) settles around 48–52px. A pane that needs smaller text uses `.hb-mono` at 12px for data, never for prose.
6. **Motion is feedback, not decoration.** Transitions are ≤200ms on hover and focus only; `prefers-reduced-motion` is respected globally in the sheet.
7. **Scoped styles.** Every rule sits under `.hb` or `.hb-portal`. A plugin never restyles host nodes it does not own.
8. **Copy**: Chinese is the source language and the default; every user-facing string goes through `t()`. Wording stays short and concrete, sentence case in English ("Connect", "Saved servers") — never shouting.

## Layout

- Workbench shell: toolbar (server strip + actions) → view tabs → pane.
- Panes are keep-alive: hidden with `display:none`, never unmounted, so the terminal pool and scroll positions survive a view switch.
- Settings pages are single-column, max 860px, grouped in `Card`s with the section title above the controls it governs.

## Component cheat-sheet

| Need | Use |
| --- | --- |
| Action | `Button variant="primary \| secondary \| ghost \| danger"` |
| Dense icon action | `IconButton icon label size="sm"` |
| Labelled input | `Field label hint error` + `TextInput` / `Select` / `TextArea` |
| Search field | `InputGroup icon="search-outline"` wrapping a `TextInput` |
| Binary setting | `Switch` (state) / `Checkbox` (selection) |
| Exclusive view switch | `Tabs` (underline) for panes, `SegmentedControl` for form modes |
| Modal | `Dialog` (focus trap, Escape, scrim) |
| Anchored menu | `Menu` + `MenuItem` + `MenuSeparator` / `MenuLabel` |
| Status | `Badge tone="ok \| warn \| err \| accent"` or `Dot` |
| Data grid | `.hb-tablewrap` + `.hb-table` |
| Nothing yet | `EmptyState icon title text action` |
| Failure | `ErrorNote`; informational → `Notice` |
| Progress | `ProgressBar` / `Spinner` |
| Confirmation | `toast(message, { tone: "error" })` for outcomes, `confirmAction({ message, danger })` for decisions — never `window.confirm` |

## Icons

`Icon name={...}` reads from `src/client/ui/icons.js`, whose geometry comes from the host's own icon sprite. Names follow the sprite's vocabulary:

`terminal server key tunnel file layers-outline save-outline search-outline
eye-outline eye-off-outline globe-outline settings-outline ellipsis-outline
plus-outline check-outline branch-outline chevron-down-outline
chevron-left-outline chevron-right-outline chevron-up-outline
triangle-right-fill close-outline copy-outline refresh-outline edit-outline
trash-outline warning-outline warning-triangle-outline check-circle-fill
check-circle-outline user-outline users-outline stop-fill loading-outline
download-outline upload-outline play-outline pause-outline fullscreen-outline
code-outline link-outline folder-open-outline folder-close data-outline
clock-outline gauge-outline shield-outline info-outline
question-outline queue-outline checklist-outline sliders-two-outline
archive-outline pin-outline drag-handle-outline wrap-lines-outline
workspace-tree-outline panel-left-outline browse-outline list-pen-outline
sparkle apps-add-outline compare-split-outline`

Adding a glyph means taking it from the host sprite (see `docs/icon-pipeline.md`), not drawing a near-miss of your own.

## Tokens and previews

The host palette is read at build time, never copied by hand:

- `npm run theme:snapshot -- <dsh-ui-theme>/src/styles` (or `DSH_THEME_CSS_DIR`) rewrites `preview/theme-fallback.css` from the installed `@deepseek-ai/dsh-client-ui-theme`. The snapshot keeps both host scopes — light under `body`, dark under `body[data-ds-dark-theme]` — and refuses to write if either lost its semantic aliases.
- `npm run preview:ui` builds offline pages against that snapshot, or against a live `DSH_THEME_CSS_DIR` when set. Add `?capture` for a full-height surface screenshot and `?bare` to hide only the preview header.
- `test/theme-snapshot.mjs` guards the snapshot shape and fails when the plugin references a host token the snapshot does not declare, so a renamed token cannot silently degrade to a CSS fallback.
