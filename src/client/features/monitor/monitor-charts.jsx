
/**
 * The two shapes the status pane draws: a trend line and the per-core bars,
 * plus the label/value row the cards share.
 *
 * Hand-rolled SVG instead of a chart library: the whole surface is one
 * polyline and a row of rectangles, and a dependency would need its own theme
 * work to match the host palette.
 */
import * as React from "react";
import { t } from "../../../i18n/core.js";
import { formatPercent, sparklinePoints, usageTone } from "./format.js";

/**
 * A trend line over a fixed or window-scaled peak. The faint area under it is
 * the same data, not a second series: it makes a low, nearly flat line (an
 * idle host) still read as a band instead of an empty box.
 * @param {{values: number[], max?: number|null, height?: number, label: string}} props
 */
export function Sparkline({ values, max = null, height = 20, label, className }) {
  const points = sparklinePoints(values, 100, height, max);
  const root = className === undefined ? "hb-spark" : "hb-spark " + className;
  if (points === "") return <div className={root + " hb-spark--empty"} aria-hidden="true" />;
  const area = points + " 100," + height + " 0," + height;
  return (
    <svg
      className={root}
      viewBox={"0 0 100 " + height}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
    >
      <polygon className="hb-spark__area" points={area} />
      <polyline
        className="hb-spark__line"
        points={points}
        fill="none"
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** One bar per core: a quiet track with the used share filled from the bottom. */
export function CoreBars({ values }) {
  if (!Array.isArray(values) || values.length === 0) return null;
  return (
    // The count is what lets the stylesheet keep the gap-to-bar ratio bounded;
    // without it a 128-core row overflows the card (see .hb-cores).
    <div className="hb-cores" role="list" aria-label={t("每核占用")} style={{ "--hb-core-count": String(values.length) }}>
      {values.map((value, index) => {
        const percent = typeof value === "number" ? Math.max(0, Math.min(100, value)) : 0;
        return (
          <span key={index} role="listitem" className="hb-core" title={t("核心") + " " + index + " · " + formatPercent(value)}>
            <span className={"hb-core__fill hb-core--" + usageTone(value)} style={{ height: percent + "%" }} />
          </span>
        );
      })}
    </div>
  );
}

/** A compact label/value line; the value may be mono data or prose. */
export function Stat({ label, value, mono = false, title }) {
  return (
    <div className="hb-stat" title={title}>
      <span className="hb-stat__label">{label}</span>
      <span className={"hb-stat__value" + (mono ? " hb-mono" : "")}>{value}</span>
    </div>
  );
}
