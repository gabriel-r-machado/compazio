import { describe, expect, it } from "vitest";

import { completeOnboarding, hasCompletedOnboarding, onboardingStorageKey } from "./onboarding";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  public getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  public setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe("onboarding state", () => {
  it("is incomplete until explicitly completed in local storage", () => {
    const storage = new MemoryStorage();

    expect(hasCompletedOnboarding(storage)).toBe(false);
    completeOnboarding(storage);

    expect(storage.getItem(onboardingStorageKey)).toBe("true");
    expect(hasCompletedOnboarding(storage)).toBe(true);
  });
});
