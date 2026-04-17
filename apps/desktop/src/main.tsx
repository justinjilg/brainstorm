import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { ToastProvider } from "./components/Toast";
import { initGlobalTooltip } from "./components/br";
import "./index.css";

// Mount the BR-style tooltip portal before React so any element with
// data-tooltip="…" — including children of other MCP-injected DOM —
// gets a styled tooltip on hover without per-component wiring.
initGlobalTooltip();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {/* Toasts mount once at the root so errors/warnings surfaced from
        any view appear over the main shell — including during mode
        switches where a view-local banner would unmount before the
        user noticed it. */}
    <ToastProvider>
      <App />
    </ToastProvider>
  </React.StrictMode>,
);
