import { describe, expect, it, vi } from "vitest";

import { CommunityEntitlementService } from "./community-entitlement-service";

describe("community desktop", () => {
  it("keeps workspaces unlimited without activation or network access", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    try {
      const service = new CommunityEntitlementService();
      for (const count of [0, 1, 10, 1000]) {
        await expect(service.assertCanCreateWorkspace(count)).resolves.toBeUndefined();
      }
      await service.activate("not-a-commercial-license");
      await service.deactivate();
      expect(await service.status()).toMatchObject({ valid: true, maxWorkspaces: null });
      expect(await new CommunityEntitlementService().status()).toEqual(await service.status());
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });
});
