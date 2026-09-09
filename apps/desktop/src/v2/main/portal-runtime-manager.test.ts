import { describe, expect, it } from "vitest";

import {
  captureEmulatedViewport,
  capturePageWithRetry,
  isAllowedPortalUrl
} from "./portal-runtime-manager";

describe("portal navigation policy", () => {
  it("allows HTTPS and local fixture addresses only", () => {
    expect(isAllowedPortalUrl("https://example.test/path")).toBe(true);
    expect(isAllowedPortalUrl("http://127.0.0.1:4100/")).toBe(true);
    expect(isAllowedPortalUrl("http://localhost:4100/")).toBe(true);
    expect(isAllowedPortalUrl("http://192.168.1.20/")).toBe(true);
  });

  it("blocks active and filesystem protocols", () => {
    expect(isAllowedPortalUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedPortalUrl("file:///C:/secret.txt")).toBe(false);
    expect(isAllowedPortalUrl("data:text/html,hello")).toBe(false);
    expect(isAllowedPortalUrl("http://example.test")).toBe(false);
  });
});

describe("PortalRuntimeManager screenshot capture", () => {
  it("captures an emulated viewport through the browser surface", async () => {
    let attached = false;
    const commands: { readonly method: string; readonly parameters?: unknown }[] = [];
    const png = Buffer.from("deterministic-png");
    const result = await captureEmulatedViewport(
      {
        debugger: {
          attach: () => {
            attached = true;
          },
          isAttached: () => attached,
          sendCommand: async (method: string, parameters?: unknown) => {
            commands.push({ method, parameters });
            return method === "Page.captureScreenshot" ? { data: png.toString("base64") } : {};
          }
        } as never
      },
      { width: 390, height: 844 },
      new AbortController().signal
    );

    expect(result).toEqual(png);
    expect(commands).toEqual([
      expect.objectContaining({
        method: "Emulation.setDeviceMetricsOverride",
        parameters: expect.objectContaining({ width: 390, height: 844, mobile: true })
      }),
      expect.objectContaining({
        method: "Page.captureScreenshot",
        parameters: expect.objectContaining({
          fromSurface: true,
          clip: { x: 0, y: 0, width: 390, height: 844, scale: 1 }
        })
      })
    ]);
  });

  it("retries transient compositor failures before saving a capture", async () => {
    const image = { marker: "png", isEmpty: () => false };
    let calls = 0;
    const retries: string[] = [];
    const result = await capturePageWithRetry(
      {
        capturePage: () => {
          calls += 1;
          return calls < 3
            ? Promise.reject(new Error("Current display surface not available for capture"))
            : Promise.resolve(image as never);
        }
      },
      new AbortController().signal,
      () => 10_000,
      (_attempt, error) => retries.push(error instanceof Error ? error.message : String(error))
    );

    expect(result).toBe(image);
    expect(calls).toBe(3);
    expect(retries).toEqual([
      "Current display surface not available for capture",
      "Current display surface not available for capture"
    ]);
  });

  it("retries empty NativeImage results without hiding real failures", async () => {
    const image = { marker: "png", isEmpty: () => false };
    let calls = 0;
    const result = await capturePageWithRetry(
      {
        capturePage: () => {
          calls += 1;
          return Promise.resolve(
            calls === 1 ? ({ isEmpty: () => true } as never) : (image as never)
          );
        }
      },
      new AbortController().signal,
      () => 10_000
    );

    expect(result).toBe(image);
    expect(calls).toBe(2);
  });

  it("does not retry an unrelated capture failure", async () => {
    const failure = new Error("capture device unavailable");
    let calls = 0;
    await expect(
      capturePageWithRetry(
        {
          capturePage: () => {
            calls += 1;
            return Promise.reject(failure);
          }
        },
        new AbortController().signal,
        () => 10_000
      )
    ).rejects.toBe(failure);
    expect(calls).toBe(1);
  });

  it("honours cancellation between capture attempts", async () => {
    const controller = new AbortController();
    let calls = 0;
    await expect(
      capturePageWithRetry(
        {
          capturePage: () => {
            calls += 1;
            return Promise.reject(new Error("UnknownVizError"));
          }
        },
        controller.signal,
        () => 10_000,
        () => controller.abort(new Error("cancelled"))
      )
    ).rejects.toThrow("cancelled");
    expect(calls).toBe(1);
  });
});
