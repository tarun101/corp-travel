import { readFileSync } from "node:fs";
import { z } from "zod";

export const AllianceSchema = z.enum(["star_alliance", "skyteam", "oneworld"]);

export const PreferencesSchema = z.object({
  name: z.string().default("Default preferences"),
  // How to weigh cheap-vs-fast when neither is a hard requirement.
  optimizeFor: z.enum(["cheapest", "fastest", "balanced"]).default("balanced"),
  preferNonstop: z.boolean().default(true),
  preferredAlliance: AllianceSchema.optional(),
  avoidRedEye: z.boolean().default(true),
  redEyeWindow: z
    .object({
      departAfter: z.string().regex(/^\d{2}:\d{2}$/),
      departBefore: z.string().regex(/^\d{2}:\d{2}$/),
    })
    .default({ departAfter: "22:00", departBefore: "05:00" }),
  preferEarlyMorning: z.boolean().default(false),
  earlyMorningWindow: z
    .object({
      start: z.string().regex(/^\d{2}:\d{2}$/),
      end: z.string().regex(/^\d{2}:\d{2}$/),
    })
    .default({ start: "05:00", end: "09:00" }),
});

export type Preferences = z.infer<typeof PreferencesSchema>;

export function loadPreferences(path: string): Preferences {
  const raw = readFileSync(path, "utf-8");
  return parsePreferences(JSON.parse(raw));
}

export function parsePreferences(json: unknown): Preferences {
  return PreferencesSchema.parse(json);
}
