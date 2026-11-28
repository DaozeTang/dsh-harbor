# UI guidelines

Harbor lives inside DeepSeek Harness. It shares the document, the theme, the font stack and the user's density setting with the rest of the app, so its job is to look like *the same product*, not a panel bolted on.

## Rules

1. **No literal design values.** No hex colours and no `px` radii in component rules; type sizes come from the six-step scale in the token block. Colours and radii resolve through the `--hb-*` tokens declared at the top of `src/client/ui/styles/app.css`, which point at the host's semantic tokens (`--dsw-alias-*`); `--hb-text-11` … `--hb-text-18` are the only place a font size is written. A value no token can express is a design question, not a CSS shortcut.
   - The only exceptions, and nothing else:
     - the `--dsh-harbor-*` migration bridge and the host-chrome nodes — the sidebar body and the header action — both declared at the bottom of `app.css`: old variables aliased onto `--hb-*` for surfaces not yet rebuilt, and host tokens carrying the literal fallbacks the sheet already declares;
     - the terminal-appearance sheet (`src/client/terminal-display/TerminalDisplaySettings.jsx`), a pre-migration surface with its own `dsh-*` namespace, inline style objects and literal radii/sizes. It is the one outstanding migration, not a precedent: a new surface is not written this way.
2. **One primary action per surface.** Everything else is `secondary` (bordered) or `ghost` (text). Destructive actions are `danger` / `danger-solid` and ask before they run.
3. **Every surface renders one of four states**: content; an empty state that says what to do next; an error note with the cause; or a disabled control that explains itself in a tooltip.
4. **Icons carry no meaning alone.** An icon-only button always has an accessible `label` (used as tooltip and `aria-label`). Icon + text beats icon-only unless it repeats a pattern directly above.
5. **Density**: 32px buttons, 34px text fields, 28px icon buttons (22px in dense toolbars), 12px labels, 13px body. Rows are 28–32px; a two-line row (title + meta) settles around 48–52px. A pane that needs smaller text uses `.hb-mono` at 12px for data, never for prose.
6. **Motion is feedback, not decoration.** Transitions are ≤200ms on hover and focus only; `prefers-reduced-motion` is respected globally in the sheet.
7. **Scoped styles.** Every rule sits under `.hb` or `.hb-portal`, except the two host-chrome nodes above (the sidebar body the workbench is mounted into, and the header action rendered into the host's slot). A plugin never restyles other host nodes it does not own.
8. **Copy**: Chinese is the source language and the default; every user-facing string goes through `t()`. Wording stays short and concrete, sentence case in English ("Connect", "Saved servers") — never shouting.

## Layout

- Workbench shell: toolbar (server strip + actions) → view tabs → pane. Six tabs fit at ~420px because the strip tightens its padding below 540px and drops inactive labels below 400px.
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
| Progress | `ProgressBar`（`tone="warn"` / `"err"` 表示读数越线）/ `Spinner` |
| Confirmation | `toast(message, { tone: "error" })` for outcomes, `confirmAction({ message, danger })` for decisions — never `window.confirm` |

## Icons

`Icon name={...}` reads from `src/client/ui/icons.js`, whose geometry comes from the host's own icon sprite. That file is the list: it carries only glyphs the product actually uses, so its keys are the canonical names and no doc copy can drift from them.

Adding a glyph means taking it from the host sprite (see `docs/icon-pipeline.md`), not drawing a near-miss of your own.

## Tokens and previews

The host palette is read at build time, never copied by hand. `preview/theme-fallback.css` is regenerated from the installed `@deepseek-ai/dsh-client-ui-theme` and keeps both host scopes — light under `body`, dark under `body[data-ds-dark-theme]`; generation refuses to write if either lost its semantic aliases. The offline pages build against that snapshot, or against a live `DSH_THEME_CSS_DIR` when set; `?capture` renders a full-height surface screenshot and `?bare` hides only the preview header. Commands, arguments and the snapshot test are documented once in [INSTALL.md](../INSTALL.md) and `test/theme-snapshot.mjs`.
