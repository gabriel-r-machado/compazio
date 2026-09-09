import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { BrowserWindow } from "electron";

export interface QaPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * Small real-window QA driver for Electron smokes. It reads the renderer only to locate and observe
 * elements; every user action is delivered through Chromium input APIs. It deliberately has no IPC,
 * store or database shortcut, so a passing scenario means the interface itself was operable.
 */
export class ElectronQaDriver {
  constructor(private readonly window: BrowserWindow) {}

  async waitForSelector(selector: string, timeoutMs = 5_000): Promise<boolean> {
    return this.waitForExpression(
      `document.querySelector(${JSON.stringify(selector)}) !== null`,
      timeoutMs
    );
  }

  async waitForExpression(expression: string, timeoutMs = 5_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      const matched: unknown = await this.window.webContents.executeJavaScript(expression, true);
      if (matched === true) return true;
      await nextAnimationFrame();
    }
    return false;
  }

  async point(selector: string): Promise<QaPoint | null> {
    const point: unknown = await this.window.webContents.executeJavaScript(
      `(()=>{
        const element=document.querySelector(${JSON.stringify(selector)});
        if(!(element instanceof HTMLElement)) return null;
        const bounds=element.getBoundingClientRect();
        if(bounds.width<2 || bounds.height<2) return null;
        return {
          x:Math.round(bounds.left+Math.min(bounds.width/2, 96)),
          y:Math.round(bounds.top+Math.min(bounds.height/2, 48))
        };
      })()`,
      true
    );
    if (typeof point !== "object" || point === null || !("x" in point) || !("y" in point)) {
      return null;
    }
    const x = point.x;
    const y = point.y;
    return typeof x === "number" && typeof y === "number" ? { x, y } : null;
  }

  async click(selector: string): Promise<boolean> {
    const point = await this.point(selector);
    if (point === null) return false;
    this.pointer(point, "left");
    return true;
  }

  async rightClick(selector: string): Promise<boolean> {
    const point = await this.point(selector);
    if (point === null) return false;
    this.pointer(point, "right");
    return true;
  }

  async press(keyCode: string): Promise<void> {
    this.window.webContents.sendInputEvent({ type: "keyDown", keyCode });
    this.window.webContents.sendInputEvent({ type: "keyUp", keyCode });
  }

  async fill(selector: string, value: string): Promise<boolean> {
    if (!(await this.click(selector))) return false;
    // Focus is dispatched through Chromium with the pointer event. Wait until the renderer reports
    // that focus has landed before inserting text; without this boundary a busy React render can
    // occasionally receive the keystrokes on the previous control in a real Electron window.
    if (
      !(await this.waitForExpression(
        `document.activeElement === document.querySelector(${JSON.stringify(selector)})`
      ))
    ) {
      return false;
    }
    this.window.webContents.sendInputEvent({
      type: "keyDown",
      keyCode: "A",
      modifiers: ["control"]
    });
    this.window.webContents.sendInputEvent({ type: "keyUp", keyCode: "A", modifiers: ["control"] });
    this.window.webContents.insertText(value);
    return this.waitForExpression(
      `(()=>{const input=document.querySelector(${JSON.stringify(selector)});return input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement ? input.value===${JSON.stringify(value)} : false;})()`
    );
  }

  async selectOption(selector: string, value: string): Promise<boolean> {
    const index: unknown = await this.window.webContents.executeJavaScript(
      `(()=>{const select=document.querySelector(${JSON.stringify(selector)});if(!(select instanceof HTMLSelectElement)) return -1;return [...select.options].findIndex(option=>option.value===${JSON.stringify(value)});})()`,
      true
    );
    if (typeof index !== "number" || index < 0 || !(await this.click(selector))) return false;
    // Native select popups are scheduled by Chromium after the pointer event. Close the popup while
    // retaining focus, then navigate the real select with the keyboard. Windows otherwise routes the
    // following key events to the native popup instead of Chromium's renderer surface.
    await nextAnimationFrame();
    await this.press("ESCAPE");
    await nextAnimationFrame();
    await this.press("HOME");
    for (let step = 0; step < index; step += 1) await this.press("DOWN");
    await this.press("ENTER");
    await nextAnimationFrame();
    return this.waitForExpression(
      `document.querySelector(${JSON.stringify(selector)}) instanceof HTMLSelectElement && document.querySelector(${JSON.stringify(selector)}).value===${JSON.stringify(value)}`
    );
  }

  async drag(sourceSelector: string, targetSelector: string): Promise<boolean> {
    const source = await this.point(sourceSelector);
    const target = await this.point(targetSelector);
    if (source === null || target === null) return false;
    this.window.webContents.sendInputEvent({ type: "mouseMove", x: source.x, y: source.y });
    this.window.webContents.sendInputEvent({
      type: "mouseDown",
      x: source.x,
      y: source.y,
      button: "left",
      clickCount: 1
    });
    for (let step = 1; step <= 8; step += 1) {
      this.window.webContents.sendInputEvent({
        type: "mouseMove",
        x: Math.round(source.x + ((target.x - source.x) * step) / 8),
        y: Math.round(source.y + ((target.y - source.y) * step) / 8)
      });
    }
    this.window.webContents.sendInputEvent({
      type: "mouseUp",
      x: target.x,
      y: target.y,
      button: "left",
      clickCount: 1
    });
    return true;
  }

  async screenshot(filename: string): Promise<void> {
    await mkdir(dirname(filename), { recursive: true });
    const image = await this.window.webContents.capturePage();
    await writeFile(filename, image.toPNG());
  }

  private pointer(point: QaPoint, button: "left" | "right"): void {
    this.window.webContents.sendInputEvent({ type: "mouseMove", x: point.x, y: point.y });
    this.window.webContents.sendInputEvent({
      type: "mouseDown",
      x: point.x,
      y: point.y,
      button,
      clickCount: 1
    });
    this.window.webContents.sendInputEvent({
      type: "mouseUp",
      x: point.x,
      y: point.y,
      button,
      clickCount: 1
    });
  }
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 16));
}
