export const onboardingStorageKey = "forgedeck.onboarding.v1.completed";

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function hasCompletedOnboarding(storage: KeyValueStorage): boolean {
  return storage.getItem(onboardingStorageKey) === "true";
}

export function completeOnboarding(storage: KeyValueStorage): void {
  storage.setItem(onboardingStorageKey, "true");
}
