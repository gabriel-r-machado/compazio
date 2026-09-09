import type { Metadata } from "next";
import type { ReactNode } from "react";

import { ErrorBoundary } from "@forgedeck/ui";
import "@forgedeck/ui/tokens.css";

import "./styles.css";

export const metadata: Metadata = {
  title: "Compazio",
  description: "Orquestração visual local-first para agentes e terminais"
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <ErrorBoundary>{children}</ErrorBoundary>
      </body>
    </html>
  );
}
