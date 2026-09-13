import type { IpcMain, WebContents } from "electron";

/** Privileged IPC belongs exclusively to the main frame of the application window. */
export function trustedRendererIpc(
  ipc: Pick<IpcMain, "handle" | "removeHandler">,
  currentRenderer: () => WebContents | null
): Pick<IpcMain, "handle" | "removeHandler"> {
  return {
    handle(channel, listener) {
      ipc.handle(channel, (event, ...args) => {
        const renderer = currentRenderer();
        if (
          renderer === null ||
          renderer.isDestroyed() ||
          event.sender !== renderer ||
          event.senderFrame === null ||
          event.senderFrame !== renderer.mainFrame
        ) {
          throw new Error("IPC_SENDER_NOT_ALLOWED");
        }
        return listener(event, ...args);
      });
    },
    removeHandler(channel) {
      ipc.removeHandler(channel);
    }
  };
}
