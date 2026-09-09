import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { ErrorBoundary } from "@forgedeck/ui";
import "@xterm/xterm/css/xterm.css";
import "@forgedeck/ui/tokens.css";
import "@xyflow/react/dist/style.css";

import { App } from "./ui/app";
import "./ui/app.css";

const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error("Compazio renderer root was not found");
}

createRoot(rootElement).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
);
