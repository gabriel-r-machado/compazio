import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "@xterm/xterm/css/xterm.css";

import { V2App } from "./ui/app";
import "./ui/app.css";

const root = document.getElementById("root");
if (root === null) throw new Error("Compazio V2 renderer root was not found");

createRoot(root).render(
  <StrictMode>
    <V2App />
  </StrictMode>
);
