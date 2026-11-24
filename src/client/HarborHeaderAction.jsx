/**
 * The session-header control that opens the workbench.
 *
 * It is a real button registered in the host's header slot rather than a node
 * spliced into the tab strip: the strip's markup and classes are internal, and
 * a copied class name is exactly the kind of dependency that breaks silently on
 * the next host release. The button reports its own active state so it reads as
 * a toggle, and repeated presses only focus the tab (the Sidebar dedupes).
 */
import * as React from "react";
import { useEffect, useState } from "react";
import { Icon } from "./ui/kit.jsx";
import { t } from "../i18n/core.js";

const POLL_MS = 1000;

export function HarborHeaderAction({ openTab, isActive, label, hint }) {
  const [active, setActive] = useState(false);

  // The Sidebar's layout store is session-scoped and offers no cross-plugin
  // subscription for the single "is my tab showing" read, so this polls. It is
  // one cheap synchronous read per second while the header is mounted.
  useEffect(() => {
    if (typeof isActive !== "function") return undefined;
    const sync = () => setActive(Boolean(isActive()));
    sync();
    const timer = setInterval(sync, POLL_MS);
    return () => clearInterval(timer);
  }, [isActive]);

  return (
    <span className="hb" style={{ display: "contents" }}>
      <button
        type="button"
        className="hb-iconbtn hb-header-action"
        data-active={active ? "true" : "false"}
        aria-pressed={active}
        aria-label={label ?? t("Harbor")}
        title={hint ?? t("打开或聚焦 Harbor 标签")}
        onClick={() => openTab?.()}
      >
        <Icon name="terminal" size={16} />
      </button>
    </span>
 );
}