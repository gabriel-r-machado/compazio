import { z } from "zod";

export const SETTINGS_GET_CHANNEL = "settings:get" as const;
export const SETTINGS_UPDATE_CHANNEL = "settings:update" as const;

export const appLocaleSchema = z.enum(["pt-BR", "en"]);
export const appThemeSchema = z.enum(["dark", "light"]);
export const appSettingsSchema = z
  .object({
    locale: appLocaleSchema,
    theme: appThemeSchema,
    activeWorkspaceId: z.string().uuid().nullable()
  })
  .strict();
export const appSettingsUpdateRequestSchema = z
  .object({
    locale: appLocaleSchema.optional(),
    theme: appThemeSchema.optional(),
    activeWorkspaceId: z.string().uuid().nullable().optional()
  })
  .strict()
  .refine(
    (value) =>
      value.locale !== undefined ||
      value.theme !== undefined ||
      value.activeWorkspaceId !== undefined,
    {
      message: "Settings update must include a supported value"
    }
  );

export type AppLocale = z.infer<typeof appLocaleSchema>;
export type AppTheme = z.infer<typeof appThemeSchema>;
export type AppSettingsDto = z.infer<typeof appSettingsSchema>;
export type AppSettingsUpdateRequest = z.infer<typeof appSettingsUpdateRequestSchema>;
