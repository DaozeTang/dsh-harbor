/**
 * Palette trigger for the terminal appearance dialog.
 *
 * The editor itself is a specialised surface (scheme rows, drag ordering, a
 * live preview); its frame is the kit's dialog, so the chrome, the close
 * affordance and the focus behaviour match every other dialog in the workbench.
 */
import * as React from "react";
import { Dialog } from "../../../ui/kit.jsx";
import { t } from "../../../../i18n/core.js";
import { useLanguage } from "../../../core/locale.js";
import { TerminalDisplaySettings } from "./TerminalDisplaySettings.jsx";

export function TerminalAppearanceButton({ style, className }) {
  useLanguage();
  const [open, setOpen] = React.useState(false);
  const trigger = React.useRef(null);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        style={style}
        className={className}
        aria-label={t("终端外观")}
        title={t("终端外观")}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M8 1.9a6.1 6.1 0 1 0 0 12.2h.8a1.55 1.55 0 0 0 1.15-2.6.9.9 0 0 1 .68-1.5h1.1a2.4 2.4 0 0 0 2.4-2.4A6 6 0 0 0 8 1.9Z" />
          <circle cx="5" cy="7.1" r=".62" /><circle cx="6.7" cy="4.6" r=".62" />
          <circle cx="9.8" cy="4.7" r=".62" /><circle cx="11.8" cy="6.8" r=".62" />
        </svg>
      </button>
      <Dialog
        open={open}
        onClose={() => { setOpen(false); trigger.current?.focus(); }}
        title={t("终端外观")}
        description={t("配色与语义高亮只影响这台浏览器里的终端显示，不影响远端输出。")}
        width="full"
      >
        <div className="dsh-appearance-body" style={{ height: "100%", minHeight: 0 }}>
          <TerminalDisplaySettings />
        </div>
      </Dialog>
    </>
  );
}
