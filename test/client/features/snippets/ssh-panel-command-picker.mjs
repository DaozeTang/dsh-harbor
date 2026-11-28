import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// The command library is a workbench view, not a popover over the server
// strip: it must stay usable while a server is connected, keep its own search
// state, and manage custom commands in place.
const panel = await readFile(new URL("../../../../src/client/shell/HarborPanel.jsx", import.meta.url), "utf8");
const view = await readFile(new URL("../../../../src/client/features/snippets/snippets-view.jsx", import.meta.url), "utf8");

assert.match(
  panel,
  /\{ value: "snippets", icon: "checklist-outline", label: \(\) => t\("快捷命令"\), feature: "showSnippets" \}/,
  "the command library is a view in the workbench switcher"
);
assert.match(panel, /<SnippetsView[\s\S]{0,200}onFilled=/, "the view renders the snippet library and reports fills");
assert.match(view, /const \[query, setQuery\] = useState\(""\);/, "the picker owns its search state");
assert.doesNotMatch(panel, /snippetPickerOpen|snippetMenu/, "the library must not overlay the server strip");
assert.match(view, /t\("自定义"\)/, "custom commands are managed inside the library");
assert.match(view, /api\.write\(targetSessionId, command\)/, "choosing a snippet types into THIS conversation's terminal instead of running it");
assert.match(view, /resolvePaneTerminal\(active, sessionId\)\.sessionId/, "the target is the pane's own PTY, resolved from the conversation id");
assert.match(view, /snippetParameters\(item\.command\)/, "parameterised snippets ask first");
assert.match(view, /expandSnippet\(draft\.item\.command, values\)/, "the preview shows the expanded command");
console.log("snippet library structure: passed");
