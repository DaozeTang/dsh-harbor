/**
 * Kit overlays — modal dialogs, confirmations, anchored menus and toasts.
 * The confirm and toast stores below are module state, so each store lives in
 * this one module and every surface that mounts a host shares it. The kit's
 * standing rules live in ../kit.jsx.
 */
import * as React from "react";
import { createPortal } from "react-dom";
import { Button, Icon, IconButton, cx } from "./primitives.jsx";
import { enterDialog, isTopDialog, leaveDialog, nextDialogOrder } from "../dialog-stack.js";
import { t } from "../../../i18n/core.js";

const { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } = React;

// ── dialogs ────────────────────────────────────────────────────────────────

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A modal dialog rendered into the document body (so a sidebar pane's overflow
 * cannot clip it) with the behaviour a modal must have: focus moves in, Tab is
 * contained, Escape closes, and focus returns to whatever opened it.
 */
export function Dialog({
  open, onClose, title, description, children, footer, width = "md", closeOnScrim = true
}) {
  const panelRef = useRef(null);
  const restoreRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const titleId = useId();
  const descId = useId();
  // Render order, not effect order: React mounts child effects before the
  // parent's, so pushing in the effect would make a nested confirmation look
  // older than the dialog that opened it.
  const orderRef = useRef(0);
  if (!open) orderRef.current = 0;
  else if (orderRef.current === 0) orderRef.current = nextDialogOrder();

  useEffect(() => {
    if (!open) return undefined;
    const dialogToken = enterDialog(orderRef.current);
    restoreRef.current = document.activeElement;
    const panel = panelRef.current;
    const first = panel?.querySelector("[data-modal-autofocus]") ?? panel?.querySelector(FOCUSABLE);
    first?.focus?.();
    const onKeyDown = (event) => {
      // Only the topmost dialog may consume keys. Escape otherwise reached
      // every open Dialog's document listener, closing a confirmation and the
      // settings dialog behind it at the same time.
      if (!isTopDialog(dialogToken)) return;
      // An open anchored menu owns Escape (it closes the menu, not the dialog).
      if (event.key === "Escape" && document.querySelector(".hb-menu") !== null) return;
      if (event.key === "Escape") { event.stopPropagation(); onCloseRef.current(); return; }
      if (event.key !== "Tab") return;
      // Focus inside a portalled menu is managed by the menu itself.
      if (document.activeElement?.closest?.(".hb-menu")) return;
      const nodes = [...(panel?.querySelectorAll(FOCUSABLE) ?? [])].filter((node) => node.offsetParent !== null);
      if (nodes.length === 0) return;
      const firstNode = nodes[0];
      const lastNode = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === firstNode) { event.preventDefault(); lastNode.focus(); }
      else if (!event.shiftKey && document.activeElement === lastNode) { event.preventDefault(); firstNode.focus(); }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      const wasTop = isTopDialog(dialogToken);
      leaveDialog(dialogToken);
      // Only the dialog that owned focus may hand it back: a lower dialog
      // unmounting under a live confirmation must not steal it.
      if (!wasTop) return;
      // Focus restoration must survive a DOM-less test harness: the dialog
      // itself only ever runs in a browser, but component tests import the kit
      // under jsdom, where HTMLElement may not be a global at all.
      const restore = restoreRef.current;
      if (typeof HTMLElement !== "undefined" && restore instanceof HTMLElement && restore.isConnected) restore.focus?.();
    };
  }, [open]);

  if (!open) return null;
  return createPortal(
    <div className="hb-portal hb">
      <div
        className="hb-scrim"
        onMouseDown={(event) => { if (closeOnScrim && event.target === event.currentTarget) onClose(); }}
      >
        <div
          ref={panelRef}
          className={cx(
            "hb-dialog",
            width === "sm" && "hb-dialog--sm",
            width === "wide" && "hb-dialog--wide",
            width === "full" && "hb-dialog--full"
          )}
          role="dialog"
          aria-modal="true"
          aria-labelledby={title !== undefined ? titleId : undefined}
          aria-describedby={description !== undefined ? descId : undefined}
        >
          <header className="hb-dialog__head">
            <div className="hb-dialog__heading">
              {title !== undefined && <h2 className="hb-dialog__title" id={titleId}>{title}</h2>}
              {description !== undefined && <p className="hb-dialog__desc" id={descId}>{description}</p>}
            </div>
            <IconButton icon="close-outline" label={t("关闭")} onClick={() => onCloseRef.current()} />
          </header>
          <div className="hb-dialog__body">{children}</div>
          {footer !== undefined && <footer className="hb-dialog__foot">{footer}</footer>}
        </div>
      </div>
    </div>,
    document.body
 );
}

// ── confirmations ─────────────────────────────────────────────────────────

/**
 * A themed confirmation for decisions the app owns (delete, relax a policy,
 * overwrite a file). `window.confirm` blocks the page, cannot be styled and
 * looks like a browser alert inside the app; this keeps destructive moments in
 * the same visual language as every other dialog.
 *
 * Resolves true for confirm, false for cancel/Escape/scrim. The host is mounted
 * by the surfaces that raise confirmations (workbench and settings page).
 */
let pendingConfirm = null;
let confirmOwner = null;
const confirmListeners = new Set();
const confirmHosts = new Set();

function notifyConfirm() {
  for (const listener of confirmListeners) listener();
}

export function confirmAction({ title, message, confirmLabel, cancelLabel, danger = false } = {}) {
  return new Promise((resolve) => {
    // A second request supersedes the first instead of stacking dialogs.
    pendingConfirm?.resolve(false);
    pendingConfirm = { title, message, confirmLabel, cancelLabel, danger, resolve };
    notifyConfirm();
  });
}

export function ConfirmHost() {
  const [state, setState] = useState(pendingConfirm);
  const [owner, setOwner] = useState(false);
  const tokenRef = useRef({});
  useEffect(() => {
    const token = tokenRef.current;
    confirmHosts.add(token);
    const sync = () => {
      // One host renders the dialog (it portals to the body, so which one is
      // irrelevant); the first mounted wins and hands over on unmount. Without
      // this, settings and the workbench would each mount a copy of the same
      // pending decision and render it twice.
      if (confirmOwner === null || !confirmHosts.has(confirmOwner)) confirmOwner = confirmHosts.values().next().value ?? null;
      setOwner(confirmOwner === token);
      setState(pendingConfirm);
    };
    sync();
    confirmListeners.add(sync);
    return () => {
      confirmListeners.delete(sync);
      confirmHosts.delete(token);
      if (confirmOwner === token) confirmOwner = null;
      notifyConfirm();
    };
  }, []);
  if (!owner || state === null) return null;
  const settle = (value) => {
    const current = pendingConfirm;
    pendingConfirm = null;
    notifyConfirm();
    current?.resolve(value);
  };
  return (
    <Dialog
      open
      onClose={() => settle(false)}
      title={state.title ?? t("确认")}
      width="sm"
      footer={
        <>
          <Button variant="ghost" onClick={() => settle(false)} data-modal-autofocus>{state.cancelLabel ?? t("取消")}</Button>
          <span className="hb-spacer" />
          <Button variant={state.danger ? "danger-solid" : "primary"} onClick={() => settle(true)}>
            {state.confirmLabel ?? t("确定")}
          </Button>
        </>
      }
    >
      <p className="hb-confirm__message">{state.message}</p>
    </Dialog>
  );
}

// ── menus ─────────────────────────────────────────────────────────────────

/**
 * An anchored menu. It positions itself against the trigger's rectangle and
 * flips when it would leave the viewport; closing happens on outside pointer
 * down, Escape, or selection.
 */
export function Menu({ open, anchorRef, onClose, children, align = "start", minWidth }) {
  const menuRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [position, setPosition] = useState(null);

  useLayoutEffect(() => {
    if (!open) return undefined;
    const place = () => {
      const anchor = anchorRef.current;
      const menu = menuRef.current;
      if (anchor === null || menu === null) return;
      const rect = anchor.getBoundingClientRect();
      const width = Math.max(menu.offsetWidth, minWidth ?? 0);
      const height = menu.offsetHeight;
      const gap = 6;
      let left = align === "end" ? rect.right - width : rect.left;
      left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
      const below = rect.bottom + gap;
      const top = below + height > window.innerHeight - 8 && rect.top - gap - height > 8
        ? rect.top - gap - height
 : below;
      setPosition({ top, left });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, anchorRef, align, minWidth]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event) => {
      if (menuRef.current?.contains(event.target) === true) return;
      if (anchorRef.current?.contains(event.target) === true) return;
      onCloseRef.current();
    };
    const onKeyDown = (event) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onCloseRef.current();
    };
    document.addEventListener("mousedown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open, anchorRef]);

  // Opening a menu is a focus move: the first item takes focus and closing
  // hands it back to the trigger, so keyboard users never lose their place.
  // The menu starts hidden until the layout effect has measured its anchor;
  // focusing a visibility:hidden element is a no-op, so wait for that state.
  const ready = position !== null;
  useEffect(() => {
    if (!open || !ready) return undefined;
    const menu = menuRef.current;
    const frame = requestAnimationFrame(() => {
      menu?.querySelector('[role="menuitem"]:not(:disabled)')?.focus?.();
    });
    return () => {
      cancelAnimationFrame(frame);
      anchorRef.current?.focus?.();
    };
  }, [open, ready, anchorRef]);

  const onMenuKeyDown = (event) => {
    if (event.key === "Tab") {
      event.preventDefault();
      onCloseRef.current();
      anchorRef.current?.focus?.();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = [...(menuRef.current?.querySelectorAll('[role="menuitem"]:not(:disabled)') ?? [])];
    if (items.length === 0) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement);
    const next = event.key === "Home" ? 0
      : event.key === "End" ? items.length - 1
        : event.key === "ArrowDown" ? (current + 1 + items.length) % items.length
          : (current - 1 + items.length) % items.length;
    items[next].focus();
  };

  if (!open) return null;
  return createPortal(
    <div className="hb-portal hb" style={{ pointerEvents: "none" }}>
      <div
        ref={menuRef}
        className="hb-popover hb-menu"
        role="menu"
        onKeyDown={onMenuKeyDown}
        style={{ top: position?.top ?? -9999, left: position?.left ?? -9999, minWidth, pointerEvents: "auto", visibility: position === null ? "hidden" : "visible" }}
      >
        {children}
      </div>
    </div>,
    document.body
 );
}

export function MenuItem({ icon, danger = false, checked = false, disabled = false, onSelect, children }) {
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      className={cx("hb-menu__item", danger && "hb-menu__item--danger", checked && "hb-menu__item--checked")}
      disabled={disabled}
      onClick={() => onSelect?.()}
    >
      {icon !== undefined && <Icon name={icon} size={14} />}
      <span style={{ flex: 1, minWidth: 0 }}>{children}</span>
      {checked && <Icon name="check-outline" size={14} />}
    </button>
 );
}

export const MenuSeparator = () => <div className="hb-menu__sep" role="separator" />;
export const MenuLabel = ({ children }) => <div className="hb-menu__label">{children}</div>;

// ── toasts ─────────────────────────────────────────────────────────────────

const toastListeners = new Set();
let toasts = [];
let toastSeq = 0;

function emit(next) {
  toasts = next;
  for (const listener of toastListeners) listener();
}

/** Show a transient message. `tone: "error"` for failures, default neutral. */
export function toast(message, { tone = "info", timeout = 3200 } = {}) {
  const id = ++toastSeq;
  emit([...toasts, { id, message, tone }]);
  if (timeout > 0) setTimeout(() => dismissToast(id), timeout);
  return id;
}

function dismissToast(id) {
  emit(toasts.filter((item) => item.id !== id));
}

/** Mount once per surface that can raise toasts. */
export function ToastHost() {
  const [items, setItems] = useState(toasts);
  useEffect(() => {
    const listener = () => setItems(toasts);
    toastListeners.add(listener);
    return () => { toastListeners.delete(listener); };
  }, []);
  if (items.length === 0) return null;
  return createPortal(
    <div className="hb-portal hb" style={{ pointerEvents: "none" }}>
      <div className="hb-toasts">
        {items.map((item) => (
          <div key={item.id} className={cx("hb-toast", item.tone === "error" && "hb-toast--err")} role="status" onClick={() => dismissToast(item.id)}>
            <Icon name={item.tone === "error" ? "warning-triangle-outline" : "check-circle-fill"} size={14} />
            <span>{item.message}</span>
          </div>
 ))}
      </div>
    </div>,
    document.body
 );
}

// ── small hooks ────────────────────────────────────────────────────────────

/**
 * Copy text, optionally announcing it. The caller owns the wording — this kit
 * carries no user-facing copy of its own, so every string stays translatable
 * at its call site.
 */
export function useCopy() {
  return useCallback(async (text, message) => {
    try {
      await navigator.clipboard.writeText(text);
      if (message !== undefined) toast(message);
      return true;
    } catch {
      return false;
    }
  }, []);
}
