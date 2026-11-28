/**
 * Kit surfaces — the containers and state panels a screen is composed from.
 * The kit's standing rules live in ../kit.jsx.
 */
import * as React from "react";
import { Icon, cx } from "./primitives.jsx";

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
