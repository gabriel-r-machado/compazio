import { describe, expect, it, vi } from "vitest";

import { handleSettingsGet, handleSettingsUpdate } from "./settings-ipc";

const workspaceId = "44ec433d-b530-46c8-874c-c678a607c295";

describe("settings IPC handlers", () => {
  it("defaults to PT-BR and exposes no generic key/value operation", () => {
    const repository = createRepository();
    expect(handleSettingsGet(repository, undefined)).toEqual({
      locale: "pt-BR",
      theme: "dark",
      activeWorkspaceId: null
    });
    expect(() => handleSettingsUpdate(repository, { key: "secret", value: "token" })).toThrow();
  });

  it("persists only the supported locale, appearance and workspace fields", () => {
    const repository = createRepository();
    handleSettingsUpdate(repository, {
      locale: "en",
      theme: "light",
      activeWorkspaceId: workspaceId
    });
    expect(repository.setLocale).toHaveBeenCalledWith("en");
    expect(repository.setTheme).toHaveBeenCalledWith("light");
    expect(repository.setActiveWorkspaceId).toHaveBeenCalledWith(workspaceId);
  });
});

function createRepository() {
  return {
    getLocale: vi.fn(() => "pt-BR" as const),
    setLocale: vi.fn(),
    getTheme: vi.fn(() => "dark" as const),
    setTheme: vi.fn(),
    getActiveWorkspaceId: vi.fn(() => null),
    setActiveWorkspaceId: vi.fn()
  };
}
