/**
 * Harbor UI kit — the workbench's own primitives.
 *
 * These are deliberately small and dependency-free: a plugin shares a document
 * with DeepSeek Harness and cannot rely on the host's internal component
 * package, so the kit reproduces the host's metrics (32px controls, 12px
 * radii, 13px type, one shared focus ring) on top of the host's semantic
 * tokens. Behaviour that the browser does not give for free — modal focus
 * containment, anchored menus, toasts — lives here once instead of in every
 * screen.
 *
 * Standing rules for every screen:
 * - never write a colour, radius or font literal; use the tokens in app.css;
 * - one primary action per surface, everything else is secondary or ghost;
 * - a surface always renders one of: content, empty state, error note, or a
 *   disabled control that explains itself.
 */
import * as React from "react";
import { createPortal } from "react-dom";
import { ICONS } from "./icons.js";
import { t } from "../../i18n/core.js";

const { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } = React;

/** Join class names, dropping falsey entries. */
export function cx(...parts) {
  return parts.filter(Boolean).join(" ");
}

// ── icons ──────────────────────────────────────────────────────────────────

/**
 * One sprite glyph. Geometry comes from icons.js; colour and size are the
 * caller's, so an icon always matches the text it sits beside.
 */
export function Icon({ name, size = 16, className, title }) {
  const glyph = ICONS[name];
  if (glyph === undefined) return null;
  return (
    <svg
      width={size}
      height={size}
      viewBox={glyph.viewBox}
      fill="none"
      stroke="currentColor"
      strokeWidth="1"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden={title === undefined ? "true" : undefined}
      role={title === undefined ? undefined : "img"}
      focusable="false"
      dangerouslySetInnerHTML={title === undefined
        ? { __html: glyph.body }
 : { __html: glyph.body + "<title>" + escapeXml(title) + "</title>" }}
    />
 );
}

function escapeXml(value) {
  return String(value).replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ── buttons ────────────────────────────────────────────────────────────────

/**
 * A button. variant: primary (one per surface) | secondary | ghost | danger |
 * danger-solid. size: md (32px) | sm (26px). `busy` swaps the label for a
 * spinner but keeps the width stable, so a submit never shifts the layout.
 */
export const Button = React.forwardRef(function Button({
  variant = "ghost",
  size = "md",
  icon,
  trailingIcon,
  busy = false,
  block = false,
  className,
  children,
  type = "button",
  disabled,
 ...rest
}, ref) {
  const iconOnly = children === undefined || children === null || children === "";
  return (
    <button
      ref={ref}
      type={type}
      className={cx(
        "hb-btn",
        `hb-btn--${variant}`,
        size === "sm" && "hb-btn--sm",
        block && "hb-btn--block",
        iconOnly && "hb-btn--icon-only",
        className
 )}
      disabled={disabled === true || busy}
      aria-busy={busy === true ? "true" : undefined}
      {...rest}
    >
      {busy ? <span className="hb-spinner" /> : icon !== undefined ? <Icon name={icon} size={size === "sm" ? 14 : 16} /> : null}
      {iconOnly ? null : children}
      {trailingIcon !== undefined && !busy ? <Icon name={trailingIcon} size={size === "sm" ? 14 : 16} /> : null}
    </button>
 );
});

/** A square 28px control for dense toolbars. `label` is its accessible name and tooltip. */
export function IconButton({ icon, label, active, size = "md", danger = false, className, ...rest }) {
  return (
    <button
      type="button"
      className={cx("hb-iconbtn", active && "hb-iconbtn--active", danger && "hb-iconbtn--danger", size === "sm" && "hb-iconbtn--sm", className)}
      title={label}
      aria-label={label}
      aria-pressed={active === undefined ? undefined : active === true}
      {...rest}
    >
      <Icon name={icon} size={size === "sm" ? 14 : 16} />
    </button>
 );
}

// ── form controls ──────────────────────────────────────────────────────────

/** A labelled field: label above, hint under, error replacing the hint. */
export function Field({ label, hint, error, htmlFor, children, className }) {
  const autoId = useId();
  const labelId = `${autoId}-label`;
  const controlId = htmlFor ?? autoId;
  // A label with no for= is decoration to screen readers. A single form
  // control gets the generated id; composites become a named group.
  let control = children;
  let associated = false;
  if (React.Children.count(children) === 1) {
    const child = React.Children.toArray(children)[0];
    if (React.isValidElement(child)) {
      const nativeControl = typeof child.type === "string" && ["input", "select", "textarea"].includes(child.type);
      if (child.type === TextInput || child.type === TextArea || child.type === Select || nativeControl) {
        control = React.cloneElement(child, { id: child.props.id ?? controlId });
        associated = true;
      } else if (child.type === InputGroup) {
        const inner = React.Children.toArray(child.props.children)[0];
        if (React.isValidElement(inner)) {
          control = React.cloneElement(child, {}, React.cloneElement(inner, { id: inner.props.id ?? controlId }));
          associated = true;
        }
      }
    }
  }
  return (
    <div className={cx("hb-field", className)}>
      {label !== undefined && (associated
        ? <label className="hb-field__label" id={labelId} htmlFor={controlId}>{label}</label>
        : <span className="hb-field__label" id={labelId}>{label}</span>)}
      {associated ? control : <div className="hb-field__group" role="group" aria-labelledby={labelId}>{control}</div>}
      {error !== undefined && error !== null && error !== ""
        ? <span className="hb-field__error" role="alert">{error}</span>
 : hint !== undefined ? <span className="hb-field__hint">{hint}</span> : null}
    </div>
 );
}

export const TextInput = React.forwardRef(function TextInput({ invalid = false, mono = false, size, className, ...rest }, ref) {
  return (
    <input
      ref={ref}
      className={cx("hb-input", invalid && "hb-input--invalid", mono && "hb-input--mono", size === "sm" && "hb-input--sm", className)}
      aria-invalid={invalid === true ? "true" : undefined}
      {...rest}
    />
 );
});

/** A text field with a leading icon and/or trailing controls. */
export function InputGroup({ icon, suffix, children, className }) {
  return (
    <div className={cx("hb-inputgroup", className)}>
      {icon !== undefined && <span className="hb-inputgroup__icon"><Icon name={icon} size={14} /></span>}
      {children}
      {suffix !== undefined && <span className="hb-inputgroup__suffix">{suffix}</span>}
    </div>
 );
}

export function TextArea({ className, ...rest }) {
  return <textarea className={cx("hb-textarea", className)} {...rest} />;
}

/**
 * A native select styled to the kit. Options are {value, label, disabled};
 * a string is accepted and used for both.
 */
export function Select({ options = [], className, ...rest }) {
  return (
    <select className={cx("hb-select", className)} {...rest}>
      {options.map((option) => {
        const value = typeof option === "string" ? option : option.value;
        const label = typeof option === "string" ? option : option.label;
        return <option key={value} value={value} disabled={option.disabled}>{label}</option>;
      })}
    </select>
 );
}

/** On/off switch with an optional inline label. */
export function Switch({ checked, onChange, disabled = false, label, id }) {
  const control = (
    <button
      type="button"
      role="switch"
      id={id}
      className="hb-switch"
      data-on={checked === true ? "true" : "false"}
      aria-checked={checked === true}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="hb-switch__thumb" />
    </button>
 );
  if (label === undefined) return control;
  return (
    <label className="hb-check" style={{ gap: 10 }}>
      {control}
      <span>{label}</span>
    </label>
 );
}

export function Checkbox({ checked, onChange, disabled = false, label, ariaLabel }) {
  const id = useId();
  return (
    <label className="hb-check" htmlFor={id}>
      <input
        id={id}
        type="checkbox"
        checked={checked === true}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label !== undefined && <span>{label}</span>}
    </label>
 );
}

/**
 * A segmented control. Items are {value, label, icon?, disabled?}; keyboard
 * users move with arrows, matching the host's own segmented switchers.
 */
export function SegmentedControl({ value, onChange, items, label, className }) {
  const onKeyDown = (event) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const enabled = items.filter((item) => item.disabled !== true);
    if (enabled.length === 0) return;
    const at = enabled.findIndex((item) => item.value === value);
    const next = enabled[(at + step + enabled.length) % enabled.length];
    onChange(next.value);
  };
  return (
    <div className={cx("hb-seg", className)} role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          role="tab"
          className="hb-seg__item"
          aria-selected={item.value === value}
          tabIndex={item.value === value ? 0 : -1}
          disabled={item.disabled}
          onClick={() => onChange(item.value)}
        >
          {item.icon !== undefined && <Icon name={item.icon} size={14} />}
          {item.label}
        </button>
 ))}
    </div>
 );
}

/** Underline tabs used for the workbench's view switcher. */
export function Tabs({ value, onChange, items, className, ariaLabel }) {
  return (
    <div className={cx("hb-tabs", className)} role="tablist" aria-label={ariaLabel}>
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          role="tab"
          className="hb-tab"
          aria-selected={item.value === value}
          disabled={item.disabled}
          onClick={() => onChange(item.value)}
          title={item.title}
        >
          {item.icon !== undefined && <Icon name={item.icon} size={14} />}
          {item.label}
          {item.count !== undefined && item.count > 0 && <span className="hb-tab__count">{item.count}</span>}
        </button>
 ))}
    </div>
 );
}

// ── surfaces ───────────────────────────────────────────────────────────────

export function Card({ title, description, action, children, className }) {
  return (
    <section className={cx("hb-card", className)}>
      {(title !== undefined || action !== undefined) && (
        <header className="hb-card__head">
          {title !== undefined && <h3 className="hb-card__title">{title}</h3>}
          {description !== undefined && <span className="hb-caption">{description}</span>}
          <span className="hb-spacer" />
          {action}
        </header>
 )}
      <div className="hb-card__body">{children}</div>
    </section>
 );
}

export function Section({ title, action, children }) {
  return (
    <section className="hb-section">
      {(title !== undefined || action !== undefined) && (
        <header className="hb-section__head">
          {title !== undefined && <h4 className="hb-section__title">{title}</h4>}
          <span className="hb-spacer" />
          {action}
        </header>
 )}
      {children}
    </section>
 );
}

export function Row({ title, meta, actions, onClick, selected = false, leading, className, titleText }) {
  const interactive = typeof onClick === "function";
  return (
    <div
      className={cx("hb-row", interactive && "hb-row--interactive", selected && "hb-row--selected", className)}
      onClick={interactive ? onClick : undefined}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      onKeyDown={interactive ? (event) => { if (event.target !== event.currentTarget) return; if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onClick(event); } } : undefined}
      title={titleText}
    >
      {leading}
      <div className="hb-row__main">
        <div className="hb-row__title">{title}</div>
        {meta !== undefined && <div className="hb-row__meta">{meta}</div>}
      </div>
      {actions !== undefined && (
        <div className="hb-row__actions" onClick={(event) => event.stopPropagation()}>{actions}</div>
 )}
    </div>
 );
}

export function Badge({ tone = "neutral", mono = false, children, title }) {
  return (
    <span className={cx("hb-badge", tone !== "neutral" && `hb-badge--${tone}`, mono && "hb-badge--mono")} title={title}>
      {children}
    </span>
 );
}

export function Dot({ tone = "idle", title }) {
  return <span className={cx("hb-dot", tone !== "idle" && `hb-dot--${tone}`)} title={title} aria-hidden="true" />;
}

export function Pill({ icon, onClick, children, title, className }) {
  const Tag = typeof onClick === "function" ? "button" : "span";
  return (
    <Tag className={cx("hb-pill", className)} onClick={onClick} type={typeof onClick === "function" ? "button" : undefined} title={title}>
      {icon !== undefined && <Icon name={icon} size={13} />}
      {children}
    </Tag>
 );
}

// ── state surfaces ─────────────────────────────────────────────────────────

export function EmptyState({ icon, title, text, action }) {
  return (
    <div className="hb-empty">
      {icon !== undefined && <div className="hb-empty__icon"><Icon name={icon} size={20} /></div>}
      {title !== undefined && <div className="hb-empty__title">{title}</div>}
      {text !== undefined && <div className="hb-empty__text">{text}</div>}
      {action}
    </div>
 );
}

export function Spinner({ label }) {
  return <span className="hb-spinner" role="status" aria-label={label} />;
}

export function ErrorNote({ children, action }) {
  return (
    <div className="hb-error" role="alert">
      <Icon name="warning-triangle-outline" size={14} />
      <span style={{ flex: 1, minWidth: 0 }}>{children}</span>
      {action}
    </div>
 );
}

export function Notice({ icon = "info-outline", children }) {
  return (
    <div className="hb-notice">
      <Icon name={icon} size={14} />
      <span style={{ flex: 1, minWidth: 0 }}>{children}</span>
    </div>
 );
}

export function ProgressBar({ value, max = 1, label, tone }) {
  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  return (
    <div className={tone === undefined ? "hb-progress" : "hb-progress hb-progress--" + tone} role="progressbar" aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} aria-label={label}>
      <div className="hb-progress__bar" style={{ width: `${Math.round(ratio * 100)}%` }} />
    </div>
 );
}

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

  useEffect(() => {
    if (!open) return undefined;
    restoreRef.current = document.activeElement;
    const panel = panelRef.current;
    const first = panel?.querySelector("[data-modal-autofocus]") ?? panel?.querySelector(FOCUSABLE);
    first?.focus?.();
    const onKeyDown = (event) => {
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

/** A hover tooltip expressed with the native title attribute — no extra layers over the terminal. */
export function Hint({ text, children }) {
  return <span title={text}>{children}</span>;
}

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

export function dismissToast(id) {
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

/** Debounce a value; used by search fields so typing never floods the host. */
export function useDebounced(value, delay = 250) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

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

/** Escape-to-close for inline popovers that are not full dialogs. */
export function useEscape(active, onEscape) {
  useEffect(() => {
    if (!active) return undefined;
    const handler = (event) => { if (event.key === "Escape") { event.stopPropagation(); onEscape(); } };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [active, onEscape]);
}

/** A stable id for aria wiring. */
export function useDomId(prefix) {
  return useMemo(() => `${prefix}-${Math.random().toString(36).slice(2, 9)}`, [prefix]);
}
