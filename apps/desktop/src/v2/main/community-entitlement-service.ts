import type { EntitlementService, EntitlementStatus } from "./entitlement-service";

/** The public desktop has no activation, installation identity or workspace quota. */
export class CommunityEntitlementService implements Pick<
  EntitlementService,
  "status" | "activate" | "deactivate" | "assertCanCreateWorkspace"
> {
  public async status(): Promise<EntitlementStatus> {
    return {
      plan: "free",
      valid: true,
      maxWorkspaces: null,
      installationId: "community-local",
      lastValidatedAt: null,
      nextValidationAt: null,
      expiresAt: null,
      reason: "none"
    };
  }

  public async assertCanCreateWorkspace(existingWorkspaceCount: number): Promise<void> {
    void existingWorkspaceCount;
  }

  public async activate(licenseCode: string): Promise<EntitlementStatus> {
    void licenseCode;
    return this.status();
  }

  public async deactivate(): Promise<void> {
    return;
  }
}
