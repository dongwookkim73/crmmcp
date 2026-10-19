import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/** Repository root (one level above server/). Runtime folders live here. */
export const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const EnvironmentSchema = z.object({
  url: z.string().url().transform((u) => u.replace(/\/+$/, "")),
  readOnly: z.boolean().default(true),
  solution: z.string().optional(),
});

const ConfigSchema = z.object({
  tenantId: z.string().min(1),
  clientId: z.string().min(1),
  auth: z
    .object({ flow: z.enum(["interactive", "deviceCode"]).default("interactive") })
    .default({ flow: "interactive" }),
  publisherPrefix: z.string().regex(/^[a-z][a-z0-9]{1,7}$/, "2-8 lowercase letters/digits, starting with a letter"),
  defaultEnvironment: z.string(),
  environments: z.record(z.string(), EnvironmentSchema),
  limits: z.object({ maxRows: z.number().int().positive().default(200) }).default({ maxRows: 200 }),
});

export type EnvironmentConfig = z.infer<typeof EnvironmentSchema>;
export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(): Config {
  const path = process.env.CRMMCP_CONFIG ?? resolve(ROOT_DIR, "config.json");
  if (!existsSync(path)) {
    throw new Error(`Config file not found: ${path}. Copy config.example.json to config.json and fill it in.`);
  }
  const config = ConfigSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  if (!config.environments[config.defaultEnvironment]) {
    throw new Error(`defaultEnvironment "${config.defaultEnvironment}" is not defined in environments.`);
  }
  return config;
}
