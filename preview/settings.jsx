/**
 * Offline preview of the settings section — the same component DSH mounts in
 * Settings, against the mock host.
 */
import * as React from "react";
import { createRoot } from "react-dom/client";
import { HarborResources } from "../src/client/features/resources/HarborResources.jsx";
import { installStyles } from "../src/client/ui/styles.js";
import { createMockApi } from "./mock-api.js";

installStyles();

const api = createMockApi();
// The credential face the host injects; writes are accepted and never read back.
const credentials = {
  set: async () => ({ ok: true }),
  get: async () => ({ ok: true, value: "" }),
  delete: async () => ({ ok: true })
};

function App() {
  return (
    <div className="hb" style={{ height: "auto", padding: 24 }}>
      <header className="hb-inline" data-preview-chrome="true" style={{ gap: 10, paddingBottom: 16 }}>
        <div className="hb-avatar"><span style={{ fontSize: 13 }}>H</span></div>
        <div>
          <div className="hb-page__title">设置 · 远程主机</div>
          <div className="hb-caption">Settings section as DSH mounts it</div>
        </div>
      </header>
      <HarborResources api={api} credentials={credentials} pluginManager={undefined} openPluginManager={undefined} />
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);