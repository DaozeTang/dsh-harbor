/**
 * The workbench tab's body inside the official right Sidebar.
 *
 * The Sidebar owns every piece of outer geometry — column width, drag-resize,
 * split, fullscreen, collapse — so this component only fills its pane and hands
 * the shell the api face.
 *
 * Lifetime notes that matter for correctness:
 * - The Sidebar draws only the ACTIVE tab's body, so switching to the built-in
 *   Files tab unmounts this. Nothing here disconnects: connections live
 *   host-side and the terminal pool keeps every xterm instance (scrollback
 *   included) alive for the next mount.
 * - Mounting is not pane identity. Splitting a single-pane root remounts this
 *   body; the host tab id passed down as `viewId` is what keeps the pane's
 *   servers across that remount, and the tab's abort signal distinguishes a
 *   vanished tab record from a remount.
 */
import * as React from "react";
import { HarborPanel } from "./HarborPanel.jsx";

export function HarborSidebarBody({ api, credentials, useTabInfo }) {
  const tab = useTabInfo === undefined ? undefined : useTabInfo();
  return (
    <div className="hb-sidebar-body" data-dsh-harbor-sidebar-body="true">
      <HarborPanel
        api={api}
        credentials={credentials}
        {...(tab === undefined ? {} : { viewId: tab.tab.id, viewSignal: tab.tab.signal })}
      />
    </div>
 );
}
