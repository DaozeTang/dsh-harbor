/**
 * Kit primitives — the controls every screen builds with, plus the cx/Icon
 * foundation the other kit modules build on. The kit's standing rules live in
 * ../kit.jsx.
 */
import * as React from "react";
import { ICONS } from "../icons.js";

const { useId, useRef } = React;

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

/**
 * Underline tabs: the workbench's view switcher.
 *
 * The label lives in `hb-tab__label` because the narrow layout hides it and
 * keeps only the icon, so the class is part of the contract, not styling
 * detail.
 */
export function Tabs({ value, onChange, items, className, ariaLabel }) {
  const refs = useRef([]);
  const current = items.findIndex((item) => item.value === value);
  /** The next enabled tab from `from` walking `direction`, wrapping once. */
  const walk = (from, direction) => {
    for (let offset = 1; offset <= items.length; offset += 1) {
      const index = ((from + direction * offset) % items.length + items.length) % items.length;
      if (items[index]?.disabled !== true) return index;
    }
    return -1;
  };
  /**
   * Keyboard model of the tablist: arrows move the selection (and the focus),
   * Home/End jump to the first/last enabled tab. Without it `role="tab"`
   * promised a tab pattern the component did not implement, and every tab was
   * its own tab stop.
   */
  const onKeyDown = (event) => {
    if (items.length === 0) return;
    const from = current < 0 ? 0 : current;
    const target = event.key === "ArrowRight" || event.key === "ArrowDown" ? walk(from, 1)
      : event.key === "ArrowLeft" || event.key === "ArrowUp" ? walk(from, -1)
      : event.key === "Home" ? walk(-1, 1)
      : event.key === "End" ? walk(items.length, -1)
      : null;
    if (target === null) return;
    event.preventDefault();
    if (target < 0) return;
    onChange(items[target].value);
    refs.current[target]?.focus?.();
  };
  return (
    <div className={cx("hb-tabs", className)} role="tablist" aria-label={ariaLabel} onKeyDown={onKeyDown}>
      {items.map((item, index) => (
        <button
          key={item.value}
          ref={(node) => { refs.current[index] = node; }}
          type="button"
          role="tab"
          className="hb-tab"
          aria-selected={item.value === value}
          aria-label={item.ariaLabel}
          disabled={item.disabled}
          // Roving tab order: the selected tab is the strip's single Tab stop.
          tabIndex={item.value === value ? 0 : -1}
          onClick={() => onChange(item.value)}
          title={item.title ?? item.label}
        >
          {item.icon !== undefined && <Icon name={item.icon} size={14} />}
          <span className="hb-tab__label">{item.label}</span>
          {item.count !== undefined && item.count > 0 && <span className="hb-tab__count">{item.count}</span>}
        </button>
 ))}
    </div>
 );
}
