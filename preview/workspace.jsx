
/**
 * Offline preview of the real workbench: the shipping components, the shipping
 * stylesheet, a fake host underneath.
 *
 * Default: two frames stacked (status dashboard + terminal) so one screenshot
 * covers the shell. "?view=status" / "?view=terminal" renders a single surface
 * at sidebar size, which is how the README screenshots are captured — a single
 * frame also means the one-shot mock terminal stream goes to the frame that is
 * actually visible.
 */
import * as React from "react";
import { createRoot } from "react-dom/client";
import { HarborPanel } from "../src/client/shell/HarborPanel.jsx";
import { harborUiSetActiveConnection, harborUiSetConnections, harborUiSetFeatures } from "../src/client/state/store.js";
import { installStyles } from "../src/client/ui/styles.js";
import { createMockApi } from "./mock-api.js";

installStyles();
harborUiSetFeatures({ showMonitor: true, showTunnels: true, showSnippets: true, showLogs: true });

const params = new URLSearchParams(location.search);
const api = createMockApi({ unsupported: params.has("unsupported") });
const view = params.get("view");

function Frame({ title, height = 560, width = "auto", children }) {
  return (
    <section className="hb" style={{ height: "auto", gap: 8, padding: "0 0 24px" }}>
      {title !== null && <div className="hb-caption" data-preview-chrome="true" style={{ paddingTop: 8 }}>{title}</div>}
      <div
        data-preview-frame="true"
        style={{ width, height, border: "1px solid var(--hb-border)", borderRadius: 12, overflow: "hidden" }}
      >
        {children}
      </div>
    </section>
  );
}

function Panel({ initialView }) {
  return (
    <div className="hb" style={{ height: "100%" }}>
      <HarborPanel api={api} credentials={undefined} initialView={initialView} />
    </div>
  );
}

function App() {
  if (view === "status" || view === "terminal") {
    return (
      <div className="hb" style={{ height: "auto", padding: 0 }}>
        <Frame title={null} width={480} height={820}>
          <Panel initialView={view === "status" ? "monitor" : "terminal"} />
        </Frame>
      </div>
    );
  }
  return (
    <div className="hb" style={{ height: "auto", padding: 24, gap: 4 }}>
      <header className="hb-inline" data-preview-chrome="true" style={{ gap: 10, paddingBottom: 12 }}>
        <div className="hb-avatar"><span style={{ fontSize: 13 }}>H</span></div>
        <div>
          <div className="hb-page__title">Harbor</div>
          <div className="hb-caption">Workbench · status, terminal, files, tunnels, logs</div>
        </div>
      </header>

      <Frame title="状态" height={720}>
        <Panel initialView="monitor" />
      </Frame>

      <Frame title="终端">
        <Panel />
      </Frame>
    </div>
  );
}

// Seed the connection store BEFORE the first render: the panel treats "no
// connections yet" as "nothing selected" and would fall back to the terminal
// tab before the first paint.
async function boot() {
  const value = await api.list();
  harborUiSetConnections(value.connections);
  harborUiSetActiveConnection(value.activeConnectionId);
  createRoot(document.getElementById("root")).render(<App />);
}

void boot();
