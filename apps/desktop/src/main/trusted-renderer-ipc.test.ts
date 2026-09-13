import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";

import { trustedRendererIpc } from "./trusted-renderer-ipc";

describe("privileged renderer IPC", () => {
  function fixture() {
    const renderer = { mainFrame: {}, isDestroyed: () => false } as WebContents;
    const handle = vi.fn<IpcMain["handle"]>();
    const removeHandler = vi.fn();
    let current: WebContents | null = renderer;
    const boundary = trustedRendererIpc({ handle, removeHandler }, () => current);
    const operation = vi.fn(() => "ok");
    boundary.handle("test:privileged", operation);
    const listener = handle.mock.calls[0]?.[1];
    if (listener === undefined) throw new Error("IPC handler was not registered");
    const invoke = (sender: WebContents, senderFrame: unknown) =>
      listener({ sender, senderFrame } as IpcMainInvokeEvent, { value: 42 });
    return {
      renderer,
      invoke,
      operation,
      boundary,
      removeHandler,
      close: () => {
        current = null;
      }
    };
  }

  it("passes the trusted main frame and preserves the payload", () => {
    const { renderer, invoke, operation } = fixture();
    expect(invoke(renderer, renderer.mainFrame)).toBe("ok");
    expect(operation).toHaveBeenCalledWith(expect.anything(), { value: 42 });
  });

  it("rejects another window, subframes, detached frames and a closed app", () => {
    const { renderer, invoke, operation, close } = fixture();
    expect(() => invoke({} as WebContents, renderer.mainFrame)).toThrow("IPC_SENDER_NOT_ALLOWED");
    expect(() => invoke(renderer, {})).toThrow("IPC_SENDER_NOT_ALLOWED");
    expect(() => invoke(renderer, null)).toThrow("IPC_SENDER_NOT_ALLOWED");
    close();
    expect(() => invoke(renderer, renderer.mainFrame)).toThrow("IPC_SENDER_NOT_ALLOWED");
    expect(operation).not.toHaveBeenCalled();
  });

  it("rejects a destroyed renderer and forwards handler cleanup", () => {
    const { renderer, invoke, operation, boundary, removeHandler } = fixture();
    renderer.isDestroyed = () => true;
    expect(() => invoke(renderer, renderer.mainFrame)).toThrow("IPC_SENDER_NOT_ALLOWED");
    expect(operation).not.toHaveBeenCalled();
    boundary.removeHandler("test:privileged");
    expect(removeHandler).toHaveBeenCalledWith("test:privileged");
  });
});
