import { createRoot } from "react-dom/client";

import { App } from "./app.jsx";

const mount = document.getElementById("root");
if (!mount) {
  // The panel is also served from memory (src/panel.ts falls back to a stub when
  // public/index.html is missing), so a missing mount point must not throw.
  console.error("[report-mcp] panel: #root not found");
} else {
  // No <StrictMode>: its double-invoked effects only exist in development, so in
  // a shipped bundle it is dead weight — and if the bundle were ever built in
  // dev mode it would double-boot the data-source probe and the SSE stream.
  createRoot(mount).render(<App />);
}
