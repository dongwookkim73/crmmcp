import type { Context } from "../context.js";
import { odataString } from "./client.js";

/** Dataverse Label payload in the organization's base language. */
export function label(text: string, languageCode: number) {
  return {
    "@odata.type": "Microsoft.Dynamics.CRM.Label",
    LocalizedLabels: [{ "@odata.type": "Microsoft.Dynamics.CRM.LocalizedLabel", Label: text, LanguageCode: languageCode }],
  };
}

/** Read the user-language text from a metadata Label. */
export function labelText(l: any): string | undefined {
  return l?.UserLocalizedLabel?.Label ?? l?.LocalizedLabels?.[0]?.Label;
}

export function requiredLevel(required?: "none" | "recommended" | "required") {
  const map = { none: "None", recommended: "Recommended", required: "ApplicationRequired" } as const;
  return { Value: map[required ?? "none"], CanBeChanged: true };
}

/** "Inspection Date" -> "dwmcp_InspectionDate" */
export function schemaNameFrom(displayName: string, prefix: string): string {
  const body = displayName
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join("");
  if (!body) throw new Error(`Cannot derive a schema name from "${displayName}". Pass schemaName explicitly.`);
  return `${prefix}_${body}`;
}

export function validateSchemaName(schemaName: string, prefix: string): void {
  if (!schemaName.toLowerCase().startsWith(`${prefix}_`)) {
    throw new Error(`Schema name "${schemaName}" must start with the publisher prefix "${prefix}_".`);
  }
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(schemaName)) {
    throw new Error(`Schema name "${schemaName}" may only contain letters, digits and underscores.`);
  }
  if (schemaName.length > 64) throw new Error(`Schema name "${schemaName}" is longer than 64 characters.`);
}

interface EntitySummary {
  logicalName: string;
  schemaName: string;
  displayName?: string;
  entitySetName: string;
  isCustom: boolean;
}

interface EnvMeta {
  languageCode?: number;
  optionValuePrefix?: Map<string, number>;
  entities?: { at: number; list: EntitySummary[] };
}

const CACHE_TTL_MS = 60 * 60 * 1000;
const cache = new Map<string, EnvMeta>();

function envMeta(ctx: Context, env?: string): EnvMeta {
  const key = ctx.envName(env);
  let meta = cache.get(key);
  if (!meta) cache.set(key, (meta = {}));
  return meta;
}

export async function baseLanguage(ctx: Context, env?: string): Promise<number> {
  const meta = envMeta(ctx, env);
  if (meta.languageCode === undefined) {
    const res = await ctx.dv(env).get("organizations?$select=languagecode");
    meta.languageCode = res.value[0]?.languagecode ?? 1033;
  }
  return meta.languageCode!;
}

/** Option values for new choices start at <publisher option value prefix> * 10000. */
export async function solutionOptionPrefix(ctx: Context, solution: string, env?: string): Promise<number> {
  const meta = envMeta(ctx, env);
  meta.optionValuePrefix ??= new Map();
  if (!meta.optionValuePrefix.has(solution)) {
    const res = await ctx.dv(env).get(
      `solutions?$filter=uniquename eq ${odataString(solution)}&$select=solutionid` +
        "&$expand=publisherid($select=customizationoptionvalueprefix)",
    );
    const prefix = res.value[0]?.publisherid?.customizationoptionvalueprefix;
    if (!prefix) throw new Error(`Solution "${solution}" not found or its publisher has no option value prefix.`);
    meta.optionValuePrefix.set(solution, prefix);
  }
  return meta.optionValuePrefix.get(solution)!;
}

export async function listEntities(ctx: Context, env?: string): Promise<EntitySummary[]> {
  const meta = envMeta(ctx, env);
  if (!meta.entities || Date.now() - meta.entities.at > CACHE_TTL_MS) {
    const res = await ctx.dv(env).get(
      "EntityDefinitions?$select=LogicalName,SchemaName,DisplayName,EntitySetName,IsCustomEntity",
    );
    meta.entities = {
      at: Date.now(),
      list: res.value.map((e: any) => ({
        logicalName: e.LogicalName,
        schemaName: e.SchemaName,
        displayName: labelText(e.DisplayName),
        entitySetName: e.EntitySetName,
        isCustom: e.IsCustomEntity,
      })),
    };
  }
  return meta.entities.list;
}

export function invalidateEntities(ctx: Context, env?: string): void {
  delete envMeta(ctx, env).entities;
}

export async function getEntity(ctx: Context, logicalName: string, env?: string): Promise<any | undefined> {
  try {
    return await ctx.dv(env).get(`EntityDefinitions(LogicalName=${odataString(logicalName)})`);
  } catch (err: any) {
    if (err.status === 404) return undefined;
    throw err;
  }
}

export async function requireEntity(ctx: Context, logicalName: string, env?: string): Promise<any> {
  const entity = await getEntity(ctx, logicalName, env);
  if (!entity) {
    const all = await listEntities(ctx, env);
    const near = all
      .filter((e) => e.logicalName.includes(logicalName) || logicalName.includes(e.logicalName))
      .slice(0, 5)
      .map((e) => e.logicalName);
    throw new Error(`Table "${logicalName}" not found.${near.length ? ` Did you mean: ${near.join(", ")}?` : ""}`);
  }
  return entity;
}

export async function getAttribute(ctx: Context, entity: string, attribute: string, env?: string): Promise<any | undefined> {
  try {
    return await ctx.dv(env).get(
      `EntityDefinitions(LogicalName=${odataString(entity)})/Attributes(LogicalName=${odataString(attribute)})`,
    );
  } catch (err: any) {
    if (err.status === 404) return undefined;
    throw err;
  }
}

/** Publish specific tables and/or global choices. */
export async function publish(ctx: Context, env: string | undefined, items: { entities?: string[]; optionSets?: string[] }) {
  const entities = (items.entities ?? []).map((e) => `<entity>${e}</entity>`).join("");
  const optionSets = (items.optionSets ?? []).map((o) => `<optionset>${o}</optionset>`).join("");
  const xml =
    "<importexportxml>" +
    (entities ? `<entities>${entities}</entities>` : "") +
    (optionSets ? `<optionsets>${optionSets}</optionsets>` : "") +
    "</importexportxml>";
  await ctx.dv(env).post("PublishXml", { ParameterXml: xml });
}
