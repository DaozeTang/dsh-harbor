/**
 * Offline preview of the real workbench: the shipping components, the shipping
 * stylesheet, a fake host underneath. Three panes are shown stacked so a design
 * review sees the shell, the terminal and a secondary view in one screenshot.
 */
import * as React from "react";
import { createRoot } from "react-dom/client";
import { HarborPanel } from "../src/client/HarborPanel.jsx";
import { harborUiSetFeatures } from "../src/client/store.js";
import { installStyles } from "../src/client/ui/styles.js";
import { createMockApi } from "./mock-api.js";

const { useEffect } = React;

installStyles();
harborUiSetFeatures({ showTunnels: true, showSnippets: true, showLogs: true });

const api = createMockApi();

function Frame({ title, height = 560, children }) {
  return (
    <section className="hb" style={{ height: "auto", gap: 8, padding: "0 0 24px" }}>
      <div className="hb-caption" data-preview-chrome="true" style={{ paddingTop: 8 }}>{title}</div>
      <div data-preview-frame="true" style={{ height, border: "1px solid var(--hb-border)", borderRadius: 12, overflow: "hidden" }}>
        {children}
      </div>
    </section>
 );
}

function App() {
  // The panel reads its connection list from the store; seed it once.
  useEffect(() => {
    void (async () => {
      const { harborUiSetConnections, harborUiSetActiveConnection } = await import("../src/client/store.js");
      const value = await api.list();
      harborUiSetConnections(value.connections);
      harborUiSetActiveConnection(value.activeConnectionId);
    })();
  }, []);

  return (
    <div className="hb" style={{ height: "auto", padding: 24, gap: 4 }}>
      <header className="hb-inline" data-preview-chrome="true" style={{ gap: 10, paddingBottom: 12 }}>
        <div className="hb-avatar"><span style={{ fontSize: 13 }}>H</span></div>
        <div>
          <div className="hb-page__title">Harbor</div>
          <div className="hb-caption">Workbench · terminal, files, tunnels, logs</div>
        </div>
      </header>

      <Frame title="终端">
        <div className="hb" style={{ height: "100%" }}>
          <HarborPanel api={api} credentials={undefined} />
        </div>
      </Frame>
    </div>
 );
}

createRoot(document.getElementById("root")).render(<App />);