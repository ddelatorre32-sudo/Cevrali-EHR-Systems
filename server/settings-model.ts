import { z } from "zod";

export const workspaceSettingsSchema = z
  .object({
    start_page: z.enum(["overview", "patients", "schedule", "queue"]),
    calendar_view: z.enum(["day", "week", "month", "list"]),
    density: z.enum(["comfortable", "compact"]),
    reduced_motion: z.boolean(),
  })
  .strict();

export type WorkspaceSettings = z.infer<typeof workspaceSettingsSchema>;

export function defaultWorkspaceSettings(): WorkspaceSettings {
  return {
    start_page: "overview",
    calendar_view: "week",
    density: "comfortable",
    reduced_motion: false,
  };
}

export const workspaceSettingsPatch = workspaceSettingsSchema.partial();
