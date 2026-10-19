import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Context } from "../context.js";
import { odataString } from "../dataverse/client.js";
import {
  baseLanguage,
  getAttribute,
  getEntity,
  invalidateEntities,
  label,
  labelText,
  listEntities,
  publish,
  requiredLevel,
  requireEntity,
  schemaNameFrom,
  solutionOptionPrefix,
  validateSchemaName,
} from "../dataverse/metadata.js";
import { registerChange, saveSnapshot } from "../pipeline/changes.js";
import { envParam, safe } from "./util.js";

// ---------------------------------------------------------------------------
// Column specs: a human-friendly shape that is translated into AttributeMetadata.
// ---------------------------------------------------------------------------

const RequiredEnum = z.enum(["none", "recommended", "required"]);
const OptionInput = z.union([z.string(), z.object({ label: z.string(), value: z.number().int().optional() })]);

const ColumnSpec = z.object({
  displayName: z.string(),
  type: z
    .enum(["text", "email", "url", "phone", "memo", "integer", "decimal", "float", "money", "date", "datetime", "boolean", "choice", "multichoice", "file", "image"])
    .describe("Column type. For lookups use relationship_plan."),
  schemaName: z.string().optional().describe("Default: <prefix>_<DisplayNameInPascalCase>"),
  description: z.string().optional(),
  required: RequiredEnum.optional(),
  maxLength: z.number().int().positive().optional().describe("text/memo (default 100 / 2000)"),
  minValue: z.number().optional(),
  maxValue: z.number().optional(),
  precision: z.number().int().min(0).max(10).optional().describe("decimal/float/money decimal places"),
  dateBehavior: z.enum(["userLocal", "dateOnly", "timeZoneIndependent"]).optional().describe("date/datetime (default userLocal; date defaults to dateOnly)"),
  options: z.array(OptionInput).optional().describe("choice/multichoice local options"),
  globalChoice: z.string().optional().describe("choice/multichoice: use an existing global choice by name instead of options"),
  trueLabel: z.string().optional(),
  falseLabel: z.string().optional(),
  defaultValue: z.boolean().optional().describe("boolean default"),
  maxSizeKB: z.number().int().positive().optional().describe("file column max size (default 32768)"),
  auditEnabled: z.boolean().optional(),
});
type ColumnSpec = z.infer<typeof ColumnSpec>;

const TYPE_NAMES: Record<ColumnSpec["type"], string> = {
  text: "String",
  email: "String",
  url: "String",
  phone: "String",
  memo: "Memo",
  integer: "Integer",
  decimal: "Decimal",
  float: "Double",
  money: "Money",
  date: "DateTime",
  datetime: "DateTime",
  boolean: "Boolean",
  choice: "Picklist",
  multichoice: "MultiSelectPicklist",
  file: "File",
  image: "Image",
};

interface BuildEnv {
  lang: number;
  prefix: string;
  optionPrefix: number;
  globalChoiceIds: Map<string, string>;
}

function options(list: z.infer<typeof OptionInput>[], b: BuildEnv) {
  return list.map((o, i) => {
    const opt = typeof o === "string" ? { label: o } : o;
    return { Value: opt.value ?? b.optionPrefix * 10000 + i, Label: label(opt.label, b.lang) };
  });
}

export function buildAttribute(spec: ColumnSpec, b: BuildEnv): Record<string, unknown> {
  const schemaName = spec.schemaName ?? schemaNameFrom(spec.displayName, b.prefix);
  validateSchemaName(schemaName, b.prefix);
  const base: Record<string, unknown> = {
    "@odata.type": `Microsoft.Dynamics.CRM.${TYPE_NAMES[spec.type]}AttributeMetadata`,
    SchemaName: schemaName,
    DisplayName: label(spec.displayName, b.lang),
    Description: label(spec.description ?? "", b.lang),
    RequiredLevel: requiredLevel(spec.required),
  };
  if (spec.auditEnabled !== undefined) base.IsAuditEnabled = { Value: spec.auditEnabled, CanBeChanged: true };

  switch (spec.type) {
    case "text":
    case "email":
    case "url":
    case "phone": {
      const format = { text: "Text", email: "Email", url: "Url", phone: "Phone" }[spec.type];
      return { ...base, MaxLength: spec.maxLength ?? 100, FormatName: { Value: format } };
    }
    case "memo":
      return { ...base, MaxLength: spec.maxLength ?? 2000, Format: "TextArea" };
    case "integer":
      return { ...base, Format: "None", MinValue: spec.minValue ?? -2147483648, MaxValue: spec.maxValue ?? 2147483647 };
    case "decimal":
      return { ...base, Precision: spec.precision ?? 2, MinValue: spec.minValue ?? -100000000000, MaxValue: spec.maxValue ?? 100000000000 };
    case "float":
      return { ...base, Precision: spec.precision ?? 2, MinValue: spec.minValue ?? -100000000000, MaxValue: spec.maxValue ?? 100000000000 };
    case "money":
      return { ...base, Precision: spec.precision ?? 2, PrecisionSource: 2, MinValue: spec.minValue ?? -922337203685477, MaxValue: spec.maxValue ?? 922337203685477 };
    case "date":
    case "datetime": {
      const behavior = spec.dateBehavior ?? (spec.type === "date" ? "dateOnly" : "userLocal");
      const behaviorValue = { userLocal: "UserLocal", dateOnly: "DateOnly", timeZoneIndependent: "TimeZoneIndependent" }[behavior];
      return { ...base, Format: spec.type === "date" ? "DateOnly" : "DateAndTime", DateTimeBehavior: { Value: behaviorValue } };
    }
    case "boolean":
      return {
        ...base,
        DefaultValue: spec.defaultValue ?? false,
        OptionSet: {
          "@odata.type": "Microsoft.Dynamics.CRM.BooleanOptionSetMetadata",
          TrueOption: { Value: 1, Label: label(spec.trueLabel ?? "Yes", b.lang) },
          FalseOption: { Value: 0, Label: label(spec.falseLabel ?? "No", b.lang) },
          OptionSetType: "Boolean",
        },
      };
    case "choice":
    case "multichoice": {
      if (spec.globalChoice) {
        const id = b.globalChoiceIds.get(spec.globalChoice);
        if (!id) throw new Error(`Global choice "${spec.globalChoice}" not found.`);
        return { ...base, "GlobalOptionSet@odata.bind": `/GlobalOptionSetDefinitions(${id})` };
      }
      if (!spec.options?.length) throw new Error(`Column "${spec.displayName}": choice columns need options or globalChoice.`);
      return {
        ...base,
        OptionSet: {
          "@odata.type": "Microsoft.Dynamics.CRM.OptionSetMetadata",
          IsGlobal: false,
          OptionSetType: "Picklist",
          Options: options(spec.options, b),
        },
      };
    }
    case "file":
      return { ...base, MaxSizeInKB: spec.maxSizeKB ?? 32768 };
    case "image":
      return { ...base, CanStoreFullImage: true, IsPrimaryImage: false };
  }
}

async function buildEnv(ctx: Context, env: string | undefined, solution: string, specs: ColumnSpec[]): Promise<BuildEnv> {
  const globalChoiceIds = new Map<string, string>();
  const needed = [...new Set(specs.map((s) => s.globalChoice).filter((n): n is string => Boolean(n)))];
  for (const name of needed) {
    try {
      const os = await ctx.dv(env).get(`GlobalOptionSetDefinitions(Name=${odataString(name)})?$select=MetadataId`);
      globalChoiceIds.set(name, os.MetadataId);
    } catch {
      // reported by buildAttribute
    }
  }
  return {
    lang: await baseLanguage(ctx, env),
    prefix: ctx.config.publisherPrefix,
    optionPrefix: await solutionOptionPrefix(ctx, solution, env),
    globalChoiceIds,
  };
}

/** Compact preview of an attribute payload for the user. */
function previewAttribute(a: Record<string, any>) {
  return {
    schemaName: a.SchemaName,
    type: String(a["@odata.type"]).replace("Microsoft.Dynamics.CRM.", "").replace("AttributeMetadata", ""),
    displayName: labelText(a.DisplayName),
    required: a.RequiredLevel?.Value,
    ...(a.MaxLength ? { maxLength: a.MaxLength } : {}),
    ...(a.OptionSet?.Options ? { options: a.OptionSet.Options.map((o: any) => `${o.Value}: ${labelText(o.Label)}`) } : {}),
    ...(a["GlobalOptionSet@odata.bind"] ? { globalChoice: a["GlobalOptionSet@odata.bind"] } : {}),
    ...(a.DateTimeBehavior ? { behavior: a.DateTimeBehavior.Value } : {}),
  };
}

const CASCADE = {
  removeLink: "RemoveLink",
  restrict: "Restrict",
  cascade: "Cascade",
} as const;

export function registerMetaTools(server: McpServer, ctx: Context): void {
  // ---------------------------------------------------------------- read
  server.registerTool(
    "meta_find",
    {
      title: "Find tables",
      description: "Search tables by logical name, schema name or display name. Cached for an hour.",
      inputSchema: {
        keyword: z.string().describe("Part of the name, e.g. 'work order' or 'msdyn_'"),
        customOnly: z.boolean().optional(),
        env: envParam,
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ keyword, customOnly, env }) => {
      const k = keyword.toLowerCase();
      const hits = (await listEntities(ctx, env)).filter(
        (e) =>
          (!customOnly || e.isCustom) &&
          (e.logicalName.includes(k) || e.schemaName.toLowerCase().includes(k) || e.displayName?.toLowerCase().includes(k)),
      );
      return { count: hits.length, tables: hits.slice(0, 50) };
    }),
  );

  server.registerTool(
    "meta_describe",
    {
      title: "Describe table",
      description: "Table metadata: settings, columns (type, required, custom), relationships, alternate keys, and optionally choice values.",
      inputSchema: {
        table: z.string().describe("Logical name, e.g. account"),
        customColumnsOnly: z.boolean().optional(),
        includeChoices: z.boolean().optional().describe("Include option values of choice columns"),
        env: envParam,
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ table, customColumnsOnly, includeChoices, env }) => {
      await requireEntity(ctx, table, env);
      const dv = ctx.dv(env);
      const t = odataString(table);
      const e = await dv.get(
        `EntityDefinitions(LogicalName=${t})?$select=LogicalName,SchemaName,DisplayName,DisplayCollectionName,Description,` +
          "EntitySetName,PrimaryIdAttribute,PrimaryNameAttribute,OwnershipType,IsCustomEntity,IsManaged,HasNotes,HasActivities,IsAuditEnabled,ChangeTrackingEnabled" +
          "&$expand=Attributes($select=LogicalName,SchemaName,DisplayName,AttributeTypeName,RequiredLevel,IsCustomAttribute,AttributeOf)," +
          "OneToManyRelationships($select=SchemaName,ReferencingEntity,ReferencingAttribute)," +
          "ManyToOneRelationships($select=SchemaName,ReferencedEntity,ReferencingAttribute)," +
          "ManyToManyRelationships($select=SchemaName,Entity1LogicalName,Entity2LogicalName,IntersectEntityName)," +
          "Keys($select=SchemaName,KeyAttributes)",
      );

      let choices: Record<string, string[]> | undefined;
      if (includeChoices) {
        choices = {};
        for (const kind of ["PicklistAttributeMetadata", "MultiSelectPicklistAttributeMetadata", "StatusAttributeMetadata", "StateAttributeMetadata"]) {
          const res = await dv.get(
            `EntityDefinitions(LogicalName=${t})/Attributes/Microsoft.Dynamics.CRM.${kind}?$select=LogicalName&$expand=OptionSet($select=Name,Options)`,
          );
          for (const a of res.value) {
            choices[a.LogicalName] = (a.OptionSet?.Options ?? []).map((o: any) => `${o.Value}: ${labelText(o.Label)}`);
          }
        }
      }

      const columns = e.Attributes.filter((a: any) => !a.AttributeOf && (!customColumnsOnly || a.IsCustomAttribute))
        .map((a: any) => ({
          name: a.LogicalName,
          displayName: labelText(a.DisplayName),
          type: a.AttributeTypeName?.Value?.replace("Type", ""),
          required: a.RequiredLevel?.Value,
          custom: a.IsCustomAttribute,
        }))
        .sort((x: any, y: any) => x.name.localeCompare(y.name));

      return {
        logicalName: e.LogicalName,
        schemaName: e.SchemaName,
        displayName: labelText(e.DisplayName),
        pluralName: labelText(e.DisplayCollectionName),
        description: labelText(e.Description),
        entitySetName: e.EntitySetName,
        primaryId: e.PrimaryIdAttribute,
        primaryName: e.PrimaryNameAttribute,
        ownership: e.OwnershipType,
        custom: e.IsCustomEntity,
        managed: e.IsManaged,
        notes: e.HasNotes,
        activities: e.HasActivities,
        audit: e.IsAuditEnabled?.Value,
        changeTracking: e.ChangeTrackingEnabled,
        columns,
        relationships: {
          oneToMany: e.OneToManyRelationships.map((r: any) => `${r.SchemaName} -> ${r.ReferencingEntity}.${r.ReferencingAttribute}`),
          manyToOne: e.ManyToOneRelationships.map((r: any) => `${r.SchemaName}: ${r.ReferencingAttribute} -> ${r.ReferencedEntity}`),
          manyToMany: e.ManyToManyRelationships.map((r: any) => `${r.SchemaName}: ${r.Entity1LogicalName} <-> ${r.Entity2LogicalName}`),
        },
        keys: e.Keys.map((k: any) => ({ name: k.SchemaName, columns: k.KeyAttributes })),
        ...(choices ? { choices } : {}),
      };
    }),
  );

  // ---------------------------------------------------------------- tables
  server.registerTool(
    "entity_plan",
    {
      title: "Plan: create or update table",
      description:
        "Plan creating a custom table (with primary name column and optional extra columns) or updating table settings. " +
        "Returns a preview and changeToken; apply with change_apply. The table is published after apply.",
      inputSchema: {
        mode: z.enum(["create", "update"]),
        table: z.string().optional().describe("update: logical name of the existing table"),
        displayName: z.string().optional(),
        pluralName: z.string().optional(),
        schemaName: z.string().optional().describe("create: default <prefix>_<DisplayName>"),
        description: z.string().optional(),
        ownership: z.enum(["user", "organization"]).optional().describe("create only (default user)"),
        hasNotes: z.boolean().optional(),
        hasActivities: z.boolean().optional().describe("Can be enabled but never disabled later"),
        auditEnabled: z.boolean().optional(),
        changeTracking: z.boolean().optional(),
        primaryName: z
          .object({ displayName: z.string().default("Name"), schemaName: z.string().optional(), maxLength: z.number().int().default(100) })
          .optional()
          .describe("create: primary name column"),
        columns: z.array(ColumnSpec).optional().describe("create: extra columns created right after the table"),
        env: envParam,
      },
    },
    safe(async (a) => {
      ctx.assertWritable(a.env);
      const env = a.env;
      const solution = ctx.requireSolution(env);
      const lang = await baseLanguage(ctx, env);
      const prefix = ctx.config.publisherPrefix;
      const dv = ctx.dv(env);

      if (a.mode === "create") {
        if (!a.displayName || !a.pluralName) throw new Error("create needs displayName and pluralName.");
        const schemaName = a.schemaName ?? schemaNameFrom(a.displayName, prefix);
        validateSchemaName(schemaName, prefix);
        const logicalName = schemaName.toLowerCase();
        if (await getEntity(ctx, logicalName, env)) throw new Error(`Table "${logicalName}" already exists. Use mode "update".`);

        const pn = a.primaryName ?? { displayName: "Name", maxLength: 100 };
        const primarySchema = pn.schemaName ?? `${prefix}_Name`;
        validateSchemaName(primarySchema, prefix);
        const body = {
          "@odata.type": "Microsoft.Dynamics.CRM.EntityMetadata",
          SchemaName: schemaName,
          DisplayName: label(a.displayName, lang),
          DisplayCollectionName: label(a.pluralName, lang),
          Description: label(a.description ?? "", lang),
          OwnershipType: a.ownership === "organization" ? "OrganizationOwned" : "UserOwned",
          IsActivity: false,
          HasNotes: a.hasNotes ?? true,
          HasActivities: a.hasActivities ?? false,
          ...(a.auditEnabled !== undefined ? { IsAuditEnabled: { Value: a.auditEnabled, CanBeChanged: true } } : {}),
          ...(a.changeTracking !== undefined ? { ChangeTrackingEnabled: a.changeTracking } : {}),
          Attributes: [
            {
              "@odata.type": "Microsoft.Dynamics.CRM.StringAttributeMetadata",
              SchemaName: primarySchema,
              IsPrimaryName: true,
              DisplayName: label(pn.displayName, lang),
              RequiredLevel: requiredLevel("required"),
              MaxLength: pn.maxLength,
              FormatName: { Value: "Text" },
            },
          ],
        };
        const b = a.columns?.length ? await buildEnv(ctx, env, solution, a.columns) : undefined;
        const extra = (a.columns ?? []).map((c) => buildAttribute(c, b!));

        return registerChange({
          tool: "entity_create",
          env: ctx.envName(env),
          solution,
          summary: `Create table ${schemaName} (${a.displayName}) with ${extra.length + 1} column(s) in solution ${solution}`,
          preview: {
            table: { schemaName, logicalName, displayName: a.displayName, pluralName: a.pluralName, ownership: body.OwnershipType, notes: body.HasNotes, activities: body.HasActivities },
            primaryName: { schemaName: primarySchema, displayName: pn.displayName, maxLength: pn.maxLength },
            columns: extra.map(previewAttribute),
          },
          execute: async () => {
            const created = await dv.post("EntityDefinitions", body, { solution });
            const results: string[] = [];
            for (const attr of extra) {
              await dv.post(`EntityDefinitions(LogicalName=${odataString(logicalName)})/Attributes`, attr, { solution });
              results.push(String(attr.SchemaName));
            }
            await publish(ctx, env, { entities: [logicalName] });
            invalidateEntities(ctx, env);
            return { metadataId: created.id, logicalName, columnsCreated: results, published: true };
          },
        });
      }

      // update
      if (!a.table) throw new Error("update needs table.");
      const current = await requireEntity(ctx, a.table, env);
      if (current.IsManaged && !current.IsCustomizable?.Value) throw new Error(`Table "${a.table}" is not customizable.`);
      if (a.hasActivities === false && current.HasActivities) throw new Error("Activities cannot be disabled once enabled.");
      const updated = structuredClone(current);
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      const set = (key: string, from: unknown, to: unknown, apply: () => void) => {
        if (to === undefined || JSON.stringify(from) === JSON.stringify(to)) return;
        changes[key] = { from, to };
        apply();
      };
      set("displayName", labelText(current.DisplayName), a.displayName, () => (updated.DisplayName = label(a.displayName!, lang)));
      set("pluralName", labelText(current.DisplayCollectionName), a.pluralName, () => (updated.DisplayCollectionName = label(a.pluralName!, lang)));
      set("description", labelText(current.Description), a.description, () => (updated.Description = label(a.description!, lang)));
      set("hasNotes", current.HasNotes, a.hasNotes, () => (updated.HasNotes = a.hasNotes));
      set("hasActivities", current.HasActivities, a.hasActivities, () => (updated.HasActivities = a.hasActivities));
      set("auditEnabled", current.IsAuditEnabled?.Value, a.auditEnabled, () => (updated.IsAuditEnabled = { ...current.IsAuditEnabled, Value: a.auditEnabled }));
      set("changeTracking", current.ChangeTrackingEnabled, a.changeTracking, () => (updated.ChangeTrackingEnabled = a.changeTracking));
      if (!Object.keys(changes).length) throw new Error("Nothing to change: all requested values already match.");

      return registerChange({
        tool: "entity_update",
        env: ctx.envName(env),
        solution,
        summary: `Update table ${a.table}: ${Object.keys(changes).join(", ")}`,
        preview: { table: a.table, changes },
        execute: async () => {
          const snapshot = saveSnapshot(ctx.envName(env), "entity", a.table!, current);
          await dv.put(`EntityDefinitions(LogicalName=${odataString(a.table!)})`, updated, {
            solution,
            headers: { "MSCRM.MergeLabels": "true" },
          });
          await publish(ctx, env, { entities: [a.table!] });
          invalidateEntities(ctx, env);
          return { snapshot, published: true };
        },
      });
    }),
  );

  // ---------------------------------------------------------------- columns
  server.registerTool(
    "column_plan",
    {
      title: "Plan: create or update columns",
      description:
        "Plan creating one or more columns on a table, or updating an existing column's label/description/required level/max length/audit. " +
        "Lookups are created with relationship_plan. Returns a changeToken for change_apply; the table is published after apply.",
      inputSchema: {
        table: z.string().describe("Table logical name"),
        mode: z.enum(["create", "update"]),
        columns: z.array(ColumnSpec).optional().describe("create: columns to add"),
        column: z.string().optional().describe("update: column logical name"),
        changes: z
          .object({
            displayName: z.string().optional(),
            description: z.string().optional(),
            required: RequiredEnum.optional(),
            maxLength: z.number().int().positive().optional(),
            auditEnabled: z.boolean().optional(),
          })
          .optional()
          .describe("update: properties to change"),
        env: envParam,
      },
    },
    safe(async (a) => {
      ctx.assertWritable(a.env);
      const env = a.env;
      const solution = ctx.requireSolution(env);
      const dv = ctx.dv(env);
      await requireEntity(ctx, a.table, env);
      const t = odataString(a.table);

      if (a.mode === "create") {
        if (!a.columns?.length) throw new Error("create needs columns.");
        const b = await buildEnv(ctx, env, solution, a.columns);
        const attrs = a.columns.map((c) => buildAttribute(c, b));
        for (const attr of attrs) {
          const logical = String(attr.SchemaName).toLowerCase();
          if (await getAttribute(ctx, a.table, logical, env)) throw new Error(`Column "${logical}" already exists on ${a.table}.`);
        }
        return registerChange({
          tool: "column_create",
          env: ctx.envName(env),
          solution,
          summary: `Create ${attrs.length} column(s) on ${a.table} in solution ${solution}`,
          preview: { table: a.table, columns: attrs.map(previewAttribute) },
          execute: async () => {
            const created: string[] = [];
            try {
              for (const attr of attrs) {
                await dv.post(`EntityDefinitions(LogicalName=${t})/Attributes`, attr, { solution });
                created.push(String(attr.SchemaName));
              }
            } finally {
              if (created.length) await publish(ctx, env, { entities: [a.table] });
            }
            return { created, published: true };
          },
        });
      }

      if (!a.column || !a.changes) throw new Error("update needs column and changes.");
      const base = await getAttribute(ctx, a.table, a.column, env);
      if (!base) throw new Error(`Column "${a.column}" not found on ${a.table}.`);
      const typeName = String(base["@odata.type"]).replace("#", "");
      const current = await dv.get(
        `EntityDefinitions(LogicalName=${t})/Attributes(LogicalName=${odataString(a.column)})/${typeName}`,
      );
      const lang = await baseLanguage(ctx, env);
      const updated = structuredClone(current);
      updated["@odata.type"] = typeName;
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      const c = a.changes;
      if (c.displayName !== undefined) {
        changes.displayName = { from: labelText(current.DisplayName), to: c.displayName };
        updated.DisplayName = label(c.displayName, lang);
      }
      if (c.description !== undefined) {
        changes.description = { from: labelText(current.Description), to: c.description };
        updated.Description = label(c.description, lang);
      }
      if (c.required !== undefined) {
        if (current.RequiredLevel?.CanBeChanged === false) throw new Error(`Required level of ${a.column} cannot be changed.`);
        changes.required = { from: current.RequiredLevel?.Value, to: requiredLevel(c.required).Value };
        updated.RequiredLevel = { ...current.RequiredLevel, Value: requiredLevel(c.required).Value };
      }
      if (c.maxLength !== undefined) {
        if (current.MaxLength === undefined) throw new Error(`${a.column} has no MaxLength (type ${typeName}).`);
        if (c.maxLength < current.MaxLength) throw new Error(`Reducing MaxLength (${current.MaxLength} -> ${c.maxLength}) can truncate data; not allowed here.`);
        changes.maxLength = { from: current.MaxLength, to: c.maxLength };
        updated.MaxLength = c.maxLength;
      }
      if (c.auditEnabled !== undefined) {
        changes.auditEnabled = { from: current.IsAuditEnabled?.Value, to: c.auditEnabled };
        updated.IsAuditEnabled = { ...current.IsAuditEnabled, Value: c.auditEnabled };
      }
      if (!Object.keys(changes).length) throw new Error("No changes given.");

      return registerChange({
        tool: "column_update",
        env: ctx.envName(env),
        solution,
        summary: `Update column ${a.table}.${a.column}: ${Object.keys(changes).join(", ")}`,
        preview: { table: a.table, column: a.column, type: typeName, changes },
        execute: async () => {
          const snapshot = saveSnapshot(ctx.envName(env), "attribute", `${a.table}.${a.column}`, current);
          await dv.put(`EntityDefinitions(LogicalName=${t})/Attributes(LogicalName=${odataString(a.column!)})`, updated, {
            solution,
            headers: { "MSCRM.MergeLabels": "true" },
          });
          await publish(ctx, env, { entities: [a.table] });
          return { snapshot, published: true };
        },
      });
    }),
  );

  // ---------------------------------------------------------------- relationships
  server.registerTool(
    "relationship_plan",
    {
      title: "Plan: create relationship",
      description:
        "Plan a 1:N relationship (creates a lookup column on the child table) or an N:N relationship. Returns a changeToken for change_apply.",
      inputSchema: {
        kind: z.enum(["oneToMany", "manyToMany"]),
        parentTable: z.string().optional().describe("1:N: the 'one' side (referenced), e.g. account"),
        childTable: z.string().optional().describe("1:N: the 'many' side that gets the lookup"),
        lookupDisplayName: z.string().optional().describe("1:N: lookup column label, e.g. 'Account'"),
        lookupSchemaName: z.string().optional().describe("1:N: default <prefix>_<LookupDisplayName>Id"),
        required: RequiredEnum.optional(),
        onParentDelete: z.enum(["removeLink", "restrict", "cascade"]).optional().describe("1:N: what happens to children when the parent is deleted (default removeLink)"),
        table1: z.string().optional().describe("N:N first table"),
        table2: z.string().optional().describe("N:N second table"),
        schemaName: z.string().optional().describe("Relationship schema name (default generated)"),
        env: envParam,
      },
    },
    safe(async (a) => {
      ctx.assertWritable(a.env);
      const env = a.env;
      const solution = ctx.requireSolution(env);
      const prefix = ctx.config.publisherPrefix;
      const lang = await baseLanguage(ctx, env);
      const dv = ctx.dv(env);

      if (a.kind === "oneToMany") {
        if (!a.parentTable || !a.childTable || !a.lookupDisplayName) {
          throw new Error("oneToMany needs parentTable, childTable and lookupDisplayName.");
        }
        const parent = await requireEntity(ctx, a.parentTable, env);
        await requireEntity(ctx, a.childTable, env);
        const lookupSchema = a.lookupSchemaName ?? `${schemaNameFrom(a.lookupDisplayName, prefix)}Id`;
        validateSchemaName(lookupSchema, prefix);
        if (await getAttribute(ctx, a.childTable, lookupSchema.toLowerCase(), env)) {
          throw new Error(`Column "${lookupSchema.toLowerCase()}" already exists on ${a.childTable}.`);
        }
        const relSchema = a.schemaName ?? `${prefix}_${a.parentTable}_${a.childTable}_${lookupSchema.toLowerCase().slice(prefix.length + 1)}`;
        validateSchemaName(relSchema, prefix);
        const deleteBehavior = CASCADE[a.onParentDelete ?? "removeLink"];
        const body = {
          "@odata.type": "Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata",
          SchemaName: relSchema,
          ReferencedEntity: a.parentTable,
          ReferencedAttribute: parent.PrimaryIdAttribute,
          ReferencingEntity: a.childTable,
          CascadeConfiguration: {
            Assign: "NoCascade",
            Delete: deleteBehavior,
            Merge: "NoCascade",
            Reparent: "NoCascade",
            Share: "NoCascade",
            Unshare: "NoCascade",
            RollupView: "NoCascade",
          },
          AssociatedMenuConfiguration: { Behavior: "UseCollectionName", Group: "Details", Order: 10000 },
          Lookup: {
            "@odata.type": "Microsoft.Dynamics.CRM.LookupAttributeMetadata",
            SchemaName: lookupSchema,
            DisplayName: label(a.lookupDisplayName, lang),
            RequiredLevel: requiredLevel(a.required),
          },
        };
        return registerChange({
          tool: "relationship_create",
          env: ctx.envName(env),
          solution,
          summary: `Create 1:N ${a.parentTable} -> ${a.childTable} (lookup ${lookupSchema}) in solution ${solution}`,
          preview: {
            relationship: relSchema,
            parent: a.parentTable,
            child: a.childTable,
            lookup: { schemaName: lookupSchema, displayName: a.lookupDisplayName, required: body.Lookup.RequiredLevel.Value },
            onParentDelete: deleteBehavior,
          },
          execute: async () => {
            const res = await dv.post("RelationshipDefinitions", body, { solution });
            await publish(ctx, env, { entities: [a.parentTable!, a.childTable!] });
            return { relationshipId: res.id, published: true };
          },
        });
      }

      if (!a.table1 || !a.table2) throw new Error("manyToMany needs table1 and table2.");
      await requireEntity(ctx, a.table1, env);
      await requireEntity(ctx, a.table2, env);
      const strip = (n: string) => n.replace(new RegExp(`^${prefix}_`), "");
      const relSchema = a.schemaName ?? `${prefix}_${strip(a.table1)}_${strip(a.table2)}`;
      validateSchemaName(relSchema, prefix);
      const menu = { Behavior: "UseCollectionName", Group: "Details", Order: 10000 };
      const body = {
        "@odata.type": "Microsoft.Dynamics.CRM.ManyToManyRelationshipMetadata",
        SchemaName: relSchema,
        IntersectEntityName: relSchema.toLowerCase(),
        Entity1LogicalName: a.table1,
        Entity2LogicalName: a.table2,
        Entity1AssociatedMenuConfiguration: menu,
        Entity2AssociatedMenuConfiguration: menu,
      };
      return registerChange({
        tool: "relationship_create",
        env: ctx.envName(env),
        solution,
        summary: `Create N:N ${a.table1} <-> ${a.table2} (${relSchema}) in solution ${solution}`,
        preview: { relationship: relSchema, table1: a.table1, table2: a.table2, intersectTable: body.IntersectEntityName },
        execute: async () => {
          const res = await dv.post("RelationshipDefinitions", body, { solution });
          await publish(ctx, env, { entities: [a.table1!, a.table2!] });
          return { relationshipId: res.id, published: true };
        },
      });
    }),
  );

  // ---------------------------------------------------------------- choices
  server.registerTool(
    "optionset_plan",
    {
      title: "Plan: global choice / choice options",
      description:
        "Plan creating a global choice, adding options to a global or local choice, or relabeling an option. Returns a changeToken for change_apply.",
      inputSchema: {
        action: z.enum(["createGlobal", "addOptions", "relabel"]),
        name: z.string().optional().describe("Global choice name (createGlobal; or addOptions/relabel on a global choice)"),
        displayName: z.string().optional().describe("createGlobal: display name"),
        table: z.string().optional().describe("addOptions/relabel on a local choice: table logical name"),
        column: z.string().optional().describe("addOptions/relabel on a local choice: column logical name"),
        options: z.array(OptionInput).optional().describe("createGlobal/addOptions"),
        value: z.number().int().optional().describe("relabel: option value"),
        newLabel: z.string().optional().describe("relabel: new label"),
        env: envParam,
      },
    },
    safe(async (a) => {
      ctx.assertWritable(a.env);
      const env = a.env;
      const solution = ctx.requireSolution(env);
      const prefix = ctx.config.publisherPrefix;
      const lang = await baseLanguage(ctx, env);
      const dv = ctx.dv(env);
      const optionPrefix = await solutionOptionPrefix(ctx, solution, env);

      if (a.action === "createGlobal") {
        if (!a.displayName || !a.options?.length) throw new Error("createGlobal needs displayName and options.");
        const name = (a.name ?? schemaNameFrom(a.displayName, prefix)).toLowerCase();
        validateSchemaName(name, prefix);
        const opts = options(a.options, { lang, prefix, optionPrefix, globalChoiceIds: new Map() });
        const body = {
          "@odata.type": "Microsoft.Dynamics.CRM.OptionSetMetadata",
          Name: name,
          DisplayName: label(a.displayName, lang),
          IsGlobal: true,
          OptionSetType: "Picklist",
          Options: opts,
        };
        return registerChange({
          tool: "optionset_create",
          env: ctx.envName(env),
          solution,
          summary: `Create global choice ${name} with ${opts.length} options in solution ${solution}`,
          preview: { name, displayName: a.displayName, options: opts.map((o) => `${o.Value}: ${labelText(o.Label)}`) },
          execute: async () => {
            const res = await dv.post("GlobalOptionSetDefinitions", body, { solution });
            await publish(ctx, env, { optionSets: [name] });
            return { metadataId: res.id, published: true };
          },
        });
      }

      // addOptions / relabel target either a global choice or a local column choice
      const target = a.name
        ? { OptionSetName: a.name }
        : a.table && a.column
          ? { EntityLogicalName: a.table, AttributeLogicalName: a.column }
          : undefined;
      if (!target) throw new Error("Give name (global choice) or table + column (local choice).");
      const publishItems = a.name ? { optionSets: [a.name] } : { entities: [a.table!] };

      // Existing options decide the next free value and catch duplicate values.
      const existing: { Value: number; Label: any }[] = a.name
        ? (await dv.get(`GlobalOptionSetDefinitions(Name=${odataString(a.name)})`)).Options
        : (
            await dv.get(
              `EntityDefinitions(LogicalName=${odataString(a.table!)})/Attributes(LogicalName=${odataString(a.column!)})/Microsoft.Dynamics.CRM.PicklistAttributeMetadata?$select=LogicalName&$expand=OptionSet($select=Options)`,
            )
          ).OptionSet.Options;
      const used = new Set(existing.map((o) => o.Value));

      if (a.action === "addOptions") {
        if (!a.options?.length) throw new Error("addOptions needs options.");
        let next = Math.max(optionPrefix * 10000 - 1, ...existing.map((o) => o.Value)) + 1;
        const toAdd = a.options.map((o) => {
          const opt = typeof o === "string" ? { label: o } : o;
          const value = opt.value ?? next++;
          if (used.has(value)) throw new Error(`Option value ${value} already exists.`);
          used.add(value);
          return { value, label: opt.label };
        });
        return registerChange({
          tool: "optionset_add",
          env: ctx.envName(env),
          solution,
          summary: `Add ${toAdd.length} option(s) to ${a.name ?? `${a.table}.${a.column}`}`,
          preview: { target, existing: existing.map((o) => `${o.Value}: ${labelText(o.Label)}`), add: toAdd.map((o) => `${o.value}: ${o.label}`) },
          execute: async () => {
            for (const o of toAdd) {
              await dv.post("InsertOptionValue", { ...target, Value: o.value, Label: label(o.label, lang), SolutionUniqueName: solution });
            }
            await publish(ctx, env, publishItems);
            return { added: toAdd.length, published: true };
          },
        });
      }

      if (a.value === undefined || !a.newLabel) throw new Error("relabel needs value and newLabel.");
      const opt = existing.find((o) => o.Value === a.value);
      if (!opt) throw new Error(`Option value ${a.value} not found.`);
      return registerChange({
        tool: "optionset_relabel",
        env: ctx.envName(env),
        solution,
        summary: `Relabel option ${a.value} on ${a.name ?? `${a.table}.${a.column}`}`,
        preview: { target, value: a.value, from: labelText(opt.Label), to: a.newLabel },
        execute: async () => {
          await dv.post("UpdateOptionValue", {
            ...target,
            Value: a.value,
            Label: label(a.newLabel!, lang),
            MergeLabels: true,
            SolutionUniqueName: solution,
          });
          await publish(ctx, env, publishItems);
          return { relabeled: true, published: true };
        },
      });
    }),
  );

  // ---------------------------------------------------------------- keys
  server.registerTool(
    "key_plan",
    {
      title: "Plan: alternate key",
      description: "Plan an alternate key on a table (index is built asynchronously after apply). Returns a changeToken for change_apply.",
      inputSchema: {
        table: z.string(),
        displayName: z.string(),
        columns: z.array(z.string()).min(1).describe("Column logical names that form the key"),
        schemaName: z.string().optional(),
        env: envParam,
      },
    },
    safe(async (a) => {
      ctx.assertWritable(a.env);
      const env = a.env;
      const solution = ctx.requireSolution(env);
      const prefix = ctx.config.publisherPrefix;
      await requireEntity(ctx, a.table, env);
      for (const col of a.columns) {
        if (!(await getAttribute(ctx, a.table, col, env))) throw new Error(`Column "${col}" not found on ${a.table}.`);
      }
      const schemaName = a.schemaName ?? schemaNameFrom(a.displayName, prefix);
      validateSchemaName(schemaName, prefix);
      const lang = await baseLanguage(ctx, env);
      const body = { SchemaName: schemaName, DisplayName: label(a.displayName, lang), KeyAttributes: a.columns };
      return registerChange({
        tool: "key_create",
        env: ctx.envName(env),
        solution,
        summary: `Create alternate key ${schemaName} on ${a.table} (${a.columns.join(", ")})`,
        preview: { table: a.table, key: schemaName, columns: a.columns },
        execute: async () => {
          const res = await ctx.dv(env).post(`EntityDefinitions(LogicalName=${odataString(a.table)})/Keys`, body, { solution });
          return { keyId: res.id, note: "Index creation runs asynchronously; check EntityKeyIndexStatus in meta_describe." };
        },
      });
    }),
  );
}
