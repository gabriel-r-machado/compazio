import { z } from "zod";

const disabledByDefaultFlagSchema = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const enabledByDefaultFlagSchema = z
  .enum(["true", "false"])
  .default("true")
  .transform((value) => value === "true");

export const featureFlagsSchema = z
  .object({
    cloud: z.boolean(),
    billing: z.boolean(),
    remoteControl: z.boolean(),
    telemetry: z.boolean(),
    orchestratorMode: z.boolean()
  })
  .readonly();

export type FeatureFlags = z.infer<typeof featureFlagsSchema>;

export function readFeatureFlags(
  environment: Readonly<Record<string, string | undefined>>
): FeatureFlags {
  return featureFlagsSchema.parse({
    cloud: disabledByDefaultFlagSchema.parse(
      environment.DESKTOP_CLOUD_SYNC ?? environment.NEXT_PUBLIC_CLOUD_ENABLED
    ),
    billing: disabledByDefaultFlagSchema.parse(environment.NEXT_PUBLIC_BILLING_ENABLED),
    remoteControl: disabledByDefaultFlagSchema.parse(environment.DESKTOP_ALLOW_REMOTE_CONTROL),
    telemetry: disabledByDefaultFlagSchema.parse(environment.NEXT_PUBLIC_TELEMETRY_ENABLED),
    // Team coordination graduated from its internal compatibility gate. Keeping the environment
    // switch provides a rollback kill switch without hiding the per-terminal user grant by default.
    orchestratorMode: enabledByDefaultFlagSchema.parse(environment.COMPAZIO_ORCHESTRATOR_MODE)
  });
}
