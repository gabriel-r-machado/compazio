import type { CompazioV2Api } from "../preload/index";

declare global {
  interface Window {
    readonly compazioV2: CompazioV2Api;
  }
}

export {};
