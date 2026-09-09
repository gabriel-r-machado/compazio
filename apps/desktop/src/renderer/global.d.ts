import type { ForgeDeckApi } from "@forgedeck/schemas";

declare global {
  interface Window {
    readonly forgedeck: ForgeDeckApi;
  }
}

export {};
