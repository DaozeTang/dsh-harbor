import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../../../${path}`, import.meta.url), "utf8");

// Closing a server tab must re-read the host list before deciding whether the
// transport can be disconnected, otherwise a five-second-old snapshot can kill
// another conversation's terminal.
{
  const panel = await read("src/client/shell/HarborPanel.jsx");
  assert.match(
    panel,
    /const latest = await api\.list\(sessionId\);\s*connection = latest\?\.connections\?\.find/,
    "HarborPanel.jsx: close-tab re-reads the host list before closeTabAction"
  );
  assert.ok(
    panel.indexOf("await api.list(sessionId)") < panel.indexOf("closeTabAction(connection, sessionId)"),
    "HarborPanel.jsx: the fresh list is read before the close action is chosen"
  );
}

// The settings page owns no pane: it must not write its session-less listing
// into the shared connection store.
{
  const resources = await read("src/client/features/resources/HarborResources.jsx");
  assert.doesNotMatch(resources, /harborUiSetConnections\(/, "HarborResources.jsx: settings cannot clobber the pane's connection list");
}

// Favorites resolve their key from the pane's connection on first render; no
// async list call may sit between the click and the write.
{
  const files = await read("src/client/features/files/HarborFiles.jsx");
  const transfers = await read("src/client/features/files/hooks/useTransfers.js");
  assert.match(files, /const favoritesStorageKey = favoritesKey\(connection\)/, "HarborFiles.jsx: favorites key is synchronous");
  assert.doesNotMatch(files, /setFavoritesStorageKey/, "HarborFiles.jsx: no late favorite-key state");
  assert.match(files, /initialPathRef/, "HarborFiles.jsx: the mount path is captured once");
  assert.match(transfers, /if \(!active \|\| !connectionId/, "useTransfers.js: transfer polling is gated by the active view");
}

// The keep-alive panes only poll while their view is visible.
{
  const panel = await read("src/client/shell/HarborPanel.jsx");
  assert.match(panel, /<HarborFiles[\s\S]{0,200}active=\{view === "files"\}/, "HarborPanel.jsx: files polling follows the active view");
  assert.match(panel, /<TunnelsPane[^>]*active=\{view === "tunnels"\}/, "HarborPanel.jsx: tunnel polling follows the active view");
  const tunnels = await read("src/client/features/tunnels/tunnels-pane.jsx");
  assert.match(tunnels, /if \(!connectionId \|\| !active\) return undefined/, "tunnels-pane.jsx: inactive panes do not poll");
  assert.match(tunnels, /loadSeq\.current/, "tunnels-pane.jsx: a stale list cannot commit to a new connection");
}


// A successful connect must refresh the pane's connection list immediately.
// The dialog opens the PTY, but the pane renders from the mirrored list, and
// the five-second poll had not run yet: the pane showed "no terminal" right
// after a connect that had just succeeded.
{
  const panel = await read("src/client/shell/HarborPanel.jsx");
  assert.match(
    panel,
    /onConnected=\{\(connectionId\) => \{[\s\S]{0,400}?void refreshConnections\(api, sessionId\);/,
    "HarborPanel.jsx: the connect dialog refreshes the connection list"
  );

  // A poll that failed once used to leave its message on screen forever: the
  // next successful list arrives five seconds later and nothing removed it.
  assert.match(
    panel,
    /if \(getHarborUiSnapshot\(\)\.error === listErrorShown\) harborUiSetError\(null\);/,
    "HarborPanel.jsx: a successful poll clears the message it wrote"
  );
  assert.ok(
    panel.indexOf("let listErrorShown = null;") < panel.indexOf("getHarborUiSnapshot().error === listErrorShown"),
    "HarborPanel.jsx: the poll's own message is tracked, so a newer error is never cleared"
  );
}

// SCP mode is a fallback, not a one-way door: the first listing decides it,
// and a subsystem that failed while the transport was reconnecting left the
// pane without delete/rename/mkdir/editor for the rest of the connection.
{
  const files = await read("src/client/features/files/HarborFiles.jsx");
  const scpPane = await read("src/client/features/files/scp-pane.jsx");
  assert.match(files, /const retrySftp = \(\) => \{/, "HarborFiles.jsx: the SCP notice offers a retry");
  assert.match(files, /setTransferMode\("sftp"\);\s*setScpReason\(""\);\s*void load\("\/"\);/, "HarborFiles.jsx: the retry leaves SCP mode and reloads");
  assert.match(scpPane, /onClick=\{retrySftp\}/, "scp-pane.jsx: the retry is wired to the notice");
}


// A crashed pane, an unsaved editor and a throwing search must all be
// recoverable in place: each one used to leave the surface permanently broken
// or silently discard work.
{
  const editor = await read("src/client/features/files/hooks/useEditor.js");
  const editorPane = await read("src/client/features/files/file-editor-pane.jsx");
  const search = await read("src/client/features/files/hooks/useFileSearch.js");
  assert.match(editor, /const closeEditor = async \(\) => \{/, "useEditor.js: one guard owns closing the editor");
  assert.match(editor, /if \(editing\.text === editing\.original\) \{ setEditing\(null\); return; \}/, "useEditor.js: an unchanged buffer closes without a prompt");
  assert.match(editorPane, /onClick=\{closeEditor\}>/, "file-editor-pane.jsx: the 关闭 button asks before discarding edits");
  assert.match(editorPane, /onClose=\{closeEditor\}/, "file-editor-pane.jsx: Escape and the scrim ask too");
  assert.match(search, /reason: cancelled \? "cancelled" : "failed"/, "useFileSearch.js: a failed search leaves the running state");
}

// Panes and the tab strips implement the patterns their ARIA roles promise.
{
  const panel = await read("src/client/shell/HarborPanel.jsx");
  assert.match(
    panel,
    /componentDidUpdate\(previous\) \{\s*if \(this\.state\.error !== null && previous\.resetKey !== this\.props\.resetKey\) this\.reset\(\);/,
    "HarborPanel.jsx: a crashed pane retries when the view or server changes"
  );
  assert.match(panel, /onClick=\{\(\) => this\.reset\(\)\}/, "HarborPanel.jsx: the error card offers a retry");
  assert.match(panel, /tabIndex=\{isActive \? 0 : -1\}/, "HarborPanel.jsx: server tabs use a roving tab order");
  assert.match(panel, /onKeyDown=\{onServerStripKeyDown\}/, "HarborPanel.jsx: arrow keys move between server tabs");
  assert.match(
    panel,
    /<\/button>\s*<button\s+type="button"\s+className="hb-server__close"/,
    "HarborPanel.jsx: the close control is a sibling of the tab, not a button inside role=tab"
  );
  assert.match(panel, /shown=\{view === "snippets"\}/, "HarborPanel.jsx: the snippets view learns when it is on screen");
  assert.match(panel, /pendingBatchRef\.current > 0 \? 1000 : 4000/, "HarborPanel.jsx: the batch poll slows down when nothing waits");

  const snippets = await read("src/client/features/snippets/snippets-view.jsx");
  assert.match(snippets, /if \(!shown\) return undefined;/, "snippets-view.jsx: autofocus waits until the tab is visible");

  const kit = await read("src/client/ui/kit/primitives.jsx");
  assert.match(kit, /const walk = \(from, direction\) => \{/, "kit.jsx: Tabs walks enabled tabs for the keyboard");
  assert.match(kit, /tabIndex=\{item\.value === value \? 0 : -1\}/, "kit.jsx: Tabs has one tab stop");
}

// A connect from the settings page must not leave the row looking disconnected
// until the five-second status poll catches up: the live 连接 button opened a
// second SSH connection (profileConnect does not reuse by default).
{
  const resources = await read("src/client/features/resources/HarborResources.jsx");
  assert.match(
    resources,
    /setConnectedProfiles\(\(current\) => \{\s*const next = new Set\(current \?\? \[\]\);\s*next\.add\(profile\.profileId\);/,
    "HarborResources.jsx: a successful connect marks the row connected immediately"
  );
}

// Every static icon name a screen asks for must exist in the sprite: Icon
// returns null for an unknown name, so a typo silently draws nothing.
{
  const { readdir } = await import("node:fs/promises");
  const walk = async (dir) => {
    const out = [];
    for (const entry of await readdir(new URL(`../../../${dir}`, import.meta.url), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) out.push(...await walk(path));
      else if (/\.(jsx|js)$/.test(entry.name)) out.push(path);
    }
    return out;
  };
  const sprite = await read("src/client/ui/icons.js");
  const known = new Set([...sprite.matchAll(/^ {2}"([a-z0-9-]+)": \{/gm)].map((m) => m[1]));
  assert.ok(known.size > 20, "the sprite parsed");
  const missing = [];
  for (const path of await walk("src/client")) {
    const source = await read(path);
    for (const match of source.matchAll(/(?:icon=|icon: |<Icon name=)"([a-z0-9-]+)"/g)) {
      if (!known.has(match[1])) missing.push(`${path}: ${match[1]}`);
    }
  }
  assert.deepEqual(missing, [], "every static icon name resolves in the sprite");
}

console.log("client state fixes: close tab, settings store, favorites, project path, polling, editor guard and pane recovery");
