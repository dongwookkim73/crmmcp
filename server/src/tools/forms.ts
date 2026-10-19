import { readFileSync, writeFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Context } from "../context.js";
import { odataString } from "../dataverse/client.js";
import { applyOps, emptyFormXml, regenerateIds, summarizeForm, xmlDiff, type FieldInfo, type FormOp } from "../dataverse/formxml.js";
import { baseLanguage, labelText, publish, requireEntity } from "../dataverse/metadata.js";
import { buildFetchXml, buildLayoutXml, lookupsUsed, summarizeView, type LinkTarget } from "../dataverse/viewxml.js";
import { registerChange, saveSnapshot } from "../pipeline/changes.js";
import { envParam, safe } from "./util.js";

const FORM_TYPES = { main: 2, quickView: 6, quickCreate: 7, card: 11 } as const;
const FORM_TYPE_NAMES: Record<number, string> = { 2: "main", 5: "mobile", 6: "quickView", 7: "quickCreate", 11: "card", 12: "mainInteractive" };

const WEB_RESOURCE_TYPES: Record<string, number> = {
  ".htm": 1, ".html": 1, ".css": 2, ".js": 3, ".xml": 4, ".png": 5, ".jpg": 6, ".jpeg": 6,
  ".gif": 7, ".xsl": 9, ".xslt": 9, ".ico": 10, ".svg": 11, ".resx": 12,
};
const TEXT_WEB_RESOURCE_TYPES = new Set([1, 2, 3, 4, 9, 11, 12]);

const id = z.string().regex(/^\{?[0-9a-fA-F-]{36}\}?$/, "GUID expected");
const bare = (g: string) => g.replace(/[{}]/g, "");

// ---------------------------------------------------------------- schemas

const FormOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("addTab"), label: z.string(), name: z.string().optional(), after: z.string().optional(), columns: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional() }),
  z.object({ op: z.literal("addSection"), tab: z.string(), label: z.string(), name: z.string().optional(), columns: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional(), showLabel: z.boolean().optional(), column: z.number().int().optional() }),
  z.object({ op: z.literal("addField"), field: z.string(), section: z.string().optional(), tab: z.string().optional(), header: z.boolean().optional(), after: z.string().optional(), label: z.string().optional(), disabled: z.boolean().optional() }),
  z.object({ op: z.literal("removeField"), field: z.string(), header: z.boolean().optional() }),
  z.object({ op: z.literal("moveField"), field: z.string(), section: z.string(), tab: z.string().optional(), after: z.string().optional() }),
  z.object({ op: z.literal("setFieldProps"), field: z.string(), label: z.string().optional(), visible: z.boolean().optional(), disabled: z.boolean().optional(), showLabel: z.boolean().optional() }),
  z.object({ op: z.literal("setTabProps"), tab: z.string(), label: z.string().optional(), visible: z.boolean().optional(), expanded: z.boolean().optional() }),
  z.object({ op: z.literal("setSectionProps"), section: z.string(), tab: z.string().optional(), label: z.string().optional(), visible: z.boolean().optional(), showLabel: z.boolean().optional() }),
  z.object({ op: z.literal("addSubgrid"), section: z.string(), tab: z.string().optional(), name: z.string(), label: z.string(), table: z.string(), relationship: z.string().optional(), viewId: z.string(), rows: z.number().int().optional() }),
  z.object({ op: z.literal("addLibrary"), library: z.string() }),
  z.object({ op: z.literal("addEventHandler"), event: z.enum(["onload", "onsave", "onchange"]), field: z.string().optional(), library: z.string(), functionName: z.string(), passContext: z.boolean().optional(), parameters: z.string().optional() }),
  z.object({ op: z.literal("removeEventHandler"), event: z.enum(["onload", "onsave", "onchange"]), field: z.string().optional(), functionName: z.string() }),
]);

const ViewColumnSchema = z.object({
  name: z.string().describe('Column logical name, or "lookupcolumn.targetcolumn" for a related table column'),
  width: z.number().int().positive().optional().describe("Pixels (default 150)"),
});
const ViewPartsShape = {
  columns: z.array(ViewColumnSchema).optional(),
  orderBy: z.array(z.object({ column: z.string(), descending: z.boolean().optional() })).optional(),
  filters: z
    .array(
      z.object({
        column: z.string(),
        operator: z.string().describe("FetchXML operator: eq, ne, gt, ge, lt, le, like, null, not-null, in, eq-userid, last-x-days, this-month, ..."),
        value: z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))]).optional(),
      }),
    )
    .optional(),
  filterType: z.enum(["and", "or"]).optional(),
  filterXml: z.string().optional().describe("Raw <filter> element; overrides filters"),
};

// ---------------------------------------------------------------- helpers

async function fieldInfo(ctx: Context, table: string, env?: string): Promise<Map<string, FieldInfo>> {
  const dv = ctx.dv(env);
  const t = odataString(table);
  const [attrs, strings] = await Promise.all([
    dv.get(`EntityDefinitions(LogicalName=${t})/Attributes?$select=LogicalName,AttributeType,AttributeTypeName,DisplayName,AttributeOf`),
    dv.get(`EntityDefinitions(LogicalName=${t})/Attributes/Microsoft.Dynamics.CRM.StringAttributeMetadata?$select=LogicalName,FormatName`),
  ]);
  const formats = new Map<string, string>(strings.value.map((s: any) => [s.LogicalName, s.FormatName?.Value]));
  const map = new Map<string, FieldInfo>();
  for (const a of attrs.value) {
    if (a.AttributeOf) continue;
    const type = a.AttributeType === "Virtual" && a.AttributeTypeName?.Value !== "MultiSelectPicklistType" ? "VirtualOther" : a.AttributeType;
    map.set(a.LogicalName, { type, format: formats.get(a.LogicalName), displayName: labelText(a.DisplayName) });
  }
  return map;
}

function webResourceChecker(ctx: Context, env?: string) {
  const known = new Map<string, boolean>();
  return async (name: string) => {
    if (!known.has(name)) {
      const res = await ctx.dv(env).get(`webresourceset?$filter=name eq ${odataString(name)}&$select=webresourceid`);
      known.set(name, res.value.length > 0);
    }
    return known.get(name)!;
  };
}

async function patchContext(ctx: Context, table: string, env?: string) {
  return { lang: await baseLanguage(ctx, env), fields: await fieldInfo(ctx, table, env), webResourceExists: webResourceChecker(ctx, env) };
}

async function getForm(ctx: Context, formId: string, env?: string) {
  return ctx.dv(env).get(
    `systemforms(${bare(formId)})?$select=formid,name,type,objecttypecode,formxml,isdefault,formactivationstate,description,ismanaged,iscustomizable`,
  );
}

async function resolveLinks(ctx: Context, table: string, columns: { name: string }[], env?: string): Promise<Map<string, LinkTarget>> {
  const links = new Map<string, LinkTarget>();
  for (const lookup of lookupsUsed(columns)) {
    let targets: string[];
    try {
      const attr = await ctx.dv(env).get(
        `EntityDefinitions(LogicalName=${odataString(table)})/Attributes(LogicalName=${odataString(lookup)})/Microsoft.Dynamics.CRM.LookupAttributeMetadata?$select=Targets`,
      );
      targets = attr.Targets ?? [];
    } catch {
      throw new Error(`"${lookup}" is not a lookup column on ${table}.`);
    }
    if (targets.length !== 1) throw new Error(`Lookup "${lookup}" targets ${targets.length} tables (${targets.join(", ")}); polymorphic lookups need filterXml/raw FetchXML.`);
    const target = await requireEntity(ctx, targets[0], env);
    links.set(lookup, { table: targets[0], primaryId: target.PrimaryIdAttribute });
  }
  return links;
}

async function validateViewColumns(ctx: Context, table: string, columns: { name: string }[], links: Map<string, LinkTarget>, env?: string) {
  const own = await fieldInfo(ctx, table, env);
  const missing: string[] = [];
  for (const c of columns) {
    if (!c.name.includes(".")) {
      if (!own.has(c.name)) missing.push(c.name);
      continue;
    }
    const [lookup, col] = c.name.split(".");
    const target = links.get(lookup)!;
    const targetFields = await fieldInfo(ctx, target.table, env);
    if (!targetFields.has(col)) missing.push(`${c.name} (${target.table}.${col})`);
  }
  if (missing.length) throw new Error(`Unknown column(s): ${missing.join(", ")}`);
}

/** Read a snapshot written by saveSnapshot and restore it (forms, views, web resources). */
function readSnapshot(file: string): { kind: string; id: string; table?: string; data: Record<string, unknown> } {
  const snap = JSON.parse(readFileSync(file, "utf8"));
  if (!snap.kind || !snap.id || !snap.data) throw new Error("This snapshot cannot be restored automatically (table/column metadata snapshots are reference only).");
  return snap;
}

// ---------------------------------------------------------------- tools

export function registerFormTools(server: McpServer, ctx: Context): void {
  // ------------------------------------------------ forms
  server.registerTool(
    "form_list",
    {
      title: "List forms",
      description: "List forms of a table with type, default flag and state.",
      inputSchema: { table: z.string(), env: envParam },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ table, env }) => {
      const res = await ctx.dv(env).get(
        `systemforms?$filter=objecttypecode eq ${odataString(table)}&$select=formid,name,type,isdefault,formactivationstate,ismanaged,description&$orderby=type,name`,
      );
      return res.value.map((f: any) => ({
        formId: f.formid,
        name: f.name,
        type: FORM_TYPE_NAMES[f.type] ?? f.type,
        default: f.isdefault,
        active: f.formactivationstate === 1,
        managed: f.ismanaged,
      }));
    }),
  );

  server.registerTool(
    "form_get",
    {
      title: "Get form layout",
      description: "Show a form as a readable tree (header, tabs → sections → fields, subgrids, libraries, event handlers). Optionally include raw FormXML.",
      inputSchema: { formId: id, includeXml: z.boolean().optional(), env: envParam },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ formId, includeXml, env }) => {
      const f = await getForm(ctx, formId, env);
      return {
        formId: f.formid,
        name: f.name,
        table: f.objecttypecode,
        type: FORM_TYPE_NAMES[f.type] ?? f.type,
        managed: f.ismanaged,
        ...summarizeForm(f.formxml),
        ...(includeXml ? { formXml: f.formxml } : {}),
      };
    }),
  );

  server.registerTool(
    "form_create_plan",
    {
      title: "Plan: create form",
      description:
        "Plan a new form, either cloned from an existing form or built from layout operations applied to an empty form " +
        "(it starts with tab \"General\" and section \"General\"). Returns a changeToken for change_apply. The table is published after apply.",
      inputSchema: {
        table: z.string(),
        name: z.string(),
        type: z.enum(["main", "quickCreate", "quickView", "card"]).default("main"),
        cloneFrom: id.optional().describe("formId to copy"),
        layout: z.array(FormOpSchema).optional().describe("Operations applied to the new form (same as form_patch_plan)"),
        description: z.string().optional(),
        env: envParam,
      },
    },
    safe(async (a) => {
      ctx.assertWritable(a.env);
      const env = a.env;
      const solution = ctx.requireSolution(env);
      await requireEntity(ctx, a.table, env);
      const pc = await patchContext(ctx, a.table, env);

      let base = emptyFormXml(pc.lang);
      if (a.cloneFrom) {
        const src = await getForm(ctx, a.cloneFrom, env);
        if (src.objecttypecode !== a.table) throw new Error(`Form ${a.cloneFrom} belongs to ${src.objecttypecode}, not ${a.table}.`);
        base = regenerateIds(src.formxml);
      }
      const { xml, log } = a.layout?.length ? await applyOps(base, a.layout as FormOp[], pc) : { xml: base, log: [] as string[] };

      return registerChange({
        tool: "form_create",
        env: ctx.envName(env),
        solution,
        summary: `Create ${a.type} form "${a.name}" on ${a.table}${a.cloneFrom ? " (cloned)" : ""} in solution ${solution}`,
        preview: { table: a.table, name: a.name, type: a.type, operations: log, layout: summarizeForm(xml) },
        execute: async () => {
          const res = await ctx.dv(env).post(
            "systemforms",
            { name: a.name, objecttypecode: a.table, type: FORM_TYPES[a.type], formxml: xml, description: a.description ?? "" },
            { solution },
          );
          await publish(ctx, env, { entities: [a.table] });
          return { formId: res.id, published: true };
        },
      });
    }),
  );

  server.registerTool(
    "form_patch_plan",
    {
      title: "Plan: customize form",
      description:
        "Plan changes to an existing form as a list of operations: addTab, addSection, addField, removeField, moveField, setFieldProps, " +
        "setTabProps, setSectionProps, addSubgrid, addLibrary, addEventHandler, removeEventHandler. Tabs/sections are matched by name or label. " +
        "Returns a diff and changeToken; apply with change_apply (snapshot saved, table published).",
      inputSchema: { formId: id, operations: z.array(FormOpSchema).min(1), env: envParam },
    },
    safe(async ({ formId, operations, env }) => {
      ctx.assertWritable(env);
      const solution = ctx.requireSolution(env);
      const form = await getForm(ctx, formId, env);
      if (form.ismanaged && form.iscustomizable?.Value === false) throw new Error("This managed form is not customizable.");
      const pc = await patchContext(ctx, form.objecttypecode, env);
      const { xml, log } = await applyOps(form.formxml, operations as FormOp[], pc);

      return registerChange({
        tool: "form_patch",
        env: ctx.envName(env),
        solution,
        summary: `Customize form "${form.name}" (${form.objecttypecode}): ${log.length} change(s)`,
        preview: { form: form.name, operations: log, diff: xmlDiff(form.formxml, xml), layoutAfter: summarizeForm(xml) },
        execute: async () => {
          const snapshot = saveSnapshot(ctx.envName(env), "form", bare(formId), {
            kind: "systemform",
            id: bare(formId),
            table: form.objecttypecode,
            data: { formxml: form.formxml },
          });
          await ctx.dv(env).patch(`systemforms(${bare(formId)})`, { formxml: xml }, { solution });
          await ctx.dv(env).post("AddSolutionComponent", {
            ComponentId: bare(formId),
            ComponentType: 60,
            SolutionUniqueName: solution,
            AddRequiredComponents: false,
          }).catch(() => undefined); // already in solution
          await publish(ctx, env, { entities: [form.objecttypecode] });
          return { snapshot, published: true };
        },
      });
    }),
  );

  // ------------------------------------------------ views
  server.registerTool(
    "view_list",
    {
      title: "List views",
      description: "List public (system) views of a table.",
      inputSchema: { table: z.string(), env: envParam },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ table, env }) => {
      const res = await ctx.dv(env).get(
        `savedqueries?$filter=returnedtypecode eq ${odataString(table)} and querytype eq 0&$select=savedqueryid,name,isdefault,statecode,ismanaged&$orderby=name`,
      );
      return res.value.map((v: any) => ({ viewId: v.savedqueryid, name: v.name, default: v.isdefault, active: v.statecode === 0, managed: v.ismanaged }));
    }),
  );

  server.registerTool(
    "view_get",
    {
      title: "Get view definition",
      description: "Show a view's columns (with widths), sort order, filter and related-table links. Optionally include raw FetchXML/LayoutXML.",
      inputSchema: { viewId: id, includeXml: z.boolean().optional(), env: envParam },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ viewId, includeXml, env }) => {
      const v = await ctx.dv(env).get(`savedqueries(${bare(viewId)})?$select=name,returnedtypecode,fetchxml,layoutxml,isdefault,querytype,ismanaged`);
      return {
        viewId: bare(viewId),
        name: v.name,
        table: v.returnedtypecode,
        default: v.isdefault,
        managed: v.ismanaged,
        ...summarizeView(v.fetchxml, v.layoutxml),
        ...(includeXml ? { fetchXml: v.fetchxml, layoutXml: v.layoutxml } : {}),
      };
    }),
  );

  server.registerTool(
    "view_create_plan",
    {
      title: "Plan: create view",
      description:
        'Plan a public view. Columns may reference related tables with "lookupcolumn.targetcolumn". Filters use FetchXML operators. ' +
        "Returns a changeToken for change_apply; the table is published after apply.",
      inputSchema: {
        table: z.string(),
        name: z.string(),
        description: z.string().optional(),
        ...ViewPartsShape,
        columns: z.array(ViewColumnSchema).min(1),
        env: envParam,
      },
    },
    safe(async (a) => {
      ctx.assertWritable(a.env);
      const env = a.env;
      const solution = ctx.requireSolution(env);
      const entity = await requireEntity(ctx, a.table, env);
      const links = await resolveLinks(ctx, a.table, a.columns, env);
      await validateViewColumns(ctx, a.table, a.columns, links, env);
      const fetchxml = buildFetchXml(a.table, entity.PrimaryIdAttribute, a, links);
      const layoutxml = buildLayoutXml(entity.ObjectTypeCode, entity.PrimaryIdAttribute, entity.PrimaryNameAttribute, a.columns);

      return registerChange({
        tool: "view_create",
        env: ctx.envName(env),
        solution,
        summary: `Create view "${a.name}" on ${a.table} in solution ${solution}`,
        preview: { table: a.table, name: a.name, ...summarizeView(fetchxml, layoutxml) },
        execute: async () => {
          const res = await ctx.dv(env).post(
            "savedqueries",
            { name: a.name, returnedtypecode: a.table, querytype: 0, fetchxml, layoutxml, description: a.description ?? "" },
            { solution },
          );
          await publish(ctx, env, { entities: [a.table] });
          return { viewId: res.id, published: true };
        },
      });
    }),
  );

  server.registerTool(
    "view_update_plan",
    {
      title: "Plan: update view",
      description:
        "Plan changes to a view. Only the parts given are replaced: columns (full new list, in order), orderBy, filters/filterXml, name. " +
        "Returns a changeToken for change_apply (snapshot saved, table published).",
      inputSchema: { viewId: id, name: z.string().optional(), ...ViewPartsShape, env: envParam },
    },
    safe(async (a) => {
      ctx.assertWritable(a.env);
      const env = a.env;
      const solution = ctx.requireSolution(env);
      const vid = bare(a.viewId);
      const v = await ctx.dv(env).get(`savedqueries(${vid})?$select=name,returnedtypecode,fetchxml,layoutxml,ismanaged,iscustomizable`);
      if (v.ismanaged && v.iscustomizable?.Value === false) throw new Error("This managed view is not customizable.");
      const entity = await requireEntity(ctx, v.returnedtypecode, env);
      const links = a.columns ? await resolveLinks(ctx, v.returnedtypecode, a.columns, env) : new Map();
      if (a.columns) await validateViewColumns(ctx, v.returnedtypecode, a.columns, links, env);

      const fetchxml = buildFetchXml(v.returnedtypecode, entity.PrimaryIdAttribute, a, links, v.fetchxml);
      const layoutxml = a.columns
        ? buildLayoutXml(entity.ObjectTypeCode, entity.PrimaryIdAttribute, entity.PrimaryNameAttribute, a.columns, v.layoutxml)
        : v.layoutxml;
      const patch: Record<string, string> = {};
      if (fetchxml !== v.fetchxml) patch.fetchxml = fetchxml;
      if (layoutxml !== v.layoutxml) patch.layoutxml = layoutxml;
      if (a.name && a.name !== v.name) patch.name = a.name;
      if (!Object.keys(patch).length) throw new Error("Nothing to change.");

      return registerChange({
        tool: "view_update",
        env: ctx.envName(env),
        solution,
        summary: `Update view "${v.name}" (${v.returnedtypecode}): ${Object.keys(patch).join(", ")}`,
        preview: { before: summarizeView(v.fetchxml, v.layoutxml), after: summarizeView(fetchxml, layoutxml), ...(patch.name ? { rename: patch.name } : {}) },
        execute: async () => {
          const snapshot = saveSnapshot(ctx.envName(env), "view", vid, {
            kind: "savedquery",
            id: vid,
            table: v.returnedtypecode,
            data: { name: v.name, fetchxml: v.fetchxml, layoutxml: v.layoutxml },
          });
          await ctx.dv(env).patch(`savedqueries(${vid})`, patch, { solution });
          await ctx.dv(env).post("AddSolutionComponent", {
            ComponentId: vid,
            ComponentType: 26,
            SolutionUniqueName: solution,
            AddRequiredComponents: false,
          }).catch(() => undefined);
          await publish(ctx, env, { entities: [v.returnedtypecode] });
          return { snapshot, published: true };
        },
      });
    }),
  );

  // ------------------------------------------------ web resources
  server.registerTool(
    "webresource_list",
    {
      title: "List web resources",
      description: "List web resources whose name contains the given text (e.g. the publisher prefix).",
      inputSchema: { nameContains: z.string(), env: envParam },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ nameContains, env }) => {
      const res = await ctx.dv(env).get(
        `webresourceset?$filter=contains(name,${odataString(nameContains)})&$select=webresourceid,name,displayname,webresourcetype,modifiedon,ismanaged&$orderby=name&$top=200`,
      );
      return res.value.map((w: any) => ({
        id: w.webresourceid,
        name: w.name,
        displayName: w.displayname,
        type: w["webresourcetype@OData.Community.Display.V1.FormattedValue"] ?? w.webresourcetype,
        modifiedOn: w.modifiedon,
        managed: w.ismanaged,
      }));
    }),
  );

  server.registerTool(
    "webresource_get",
    {
      title: "Get web resource",
      description: "Return a text web resource's content (truncated at 20,000 chars), or save it to a local file with saveTo.",
      inputSchema: { name: z.string(), saveTo: z.string().optional().describe("Local file path to write the content to"), env: envParam },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ name, saveTo, env }) => {
      const res = await ctx.dv(env).get(`webresourceset?$filter=name eq ${odataString(name)}&$select=webresourceid,name,webresourcetype,content`);
      const w = res.value[0];
      if (!w) throw new Error(`Web resource "${name}" not found.`);
      const buf = Buffer.from(w.content ?? "", "base64");
      if (saveTo) {
        const path = resolve(saveTo);
        writeFileSync(path, buf);
        return { saved: path, bytes: buf.length };
      }
      if (!TEXT_WEB_RESOURCE_TYPES.has(w.webresourcetype)) return { name, bytes: buf.length, note: "Binary resource; use saveTo." };
      const text = buf.toString("utf8");
      return { name, id: w.webresourceid, content: text.length > 20000 ? `${text.slice(0, 20000)}\n... (truncated, ${text.length} chars)` : text };
    }),
  );

  server.registerTool(
    "webresource_upsert_plan",
    {
      title: "Plan: create/update web resource",
      description:
        "Plan uploading a local file as a web resource (type from extension). Creates it if missing, otherwise updates content (snapshot saved). " +
        "Name must start with the publisher prefix, e.g. dwmcp_/scripts/inspection.js. Returns a changeToken; published after apply.",
      inputSchema: {
        name: z.string(),
        filePath: z.string().describe("Local file to upload"),
        displayName: z.string().optional(),
        env: envParam,
      },
    },
    safe(async ({ name, filePath, displayName, env }) => {
      ctx.assertWritable(env);
      const solution = ctx.requireSolution(env);
      const prefix = ctx.config.publisherPrefix;
      if (!name.startsWith(`${prefix}_`)) throw new Error(`Web resource name must start with "${prefix}_".`);
      const type = WEB_RESOURCE_TYPES[extname(name).toLowerCase()] ?? WEB_RESOURCE_TYPES[extname(filePath).toLowerCase()];
      if (!type) throw new Error(`Unsupported web resource extension: ${extname(name) || extname(filePath)}`);
      const path = resolve(filePath);
      const content = readFileSync(path);
      const dv = ctx.dv(env);
      const res = await dv.get(`webresourceset?$filter=name eq ${odataString(name)}&$select=webresourceid,content,webresourcetype,ismanaged`);
      const existing = res.value[0];
      if (existing?.ismanaged) throw new Error(`"${name}" is managed and cannot be updated here.`);
      const before = existing ? Buffer.from(existing.content ?? "", "base64") : undefined;
      if (before?.equals(content)) throw new Error("Local file is identical to the current web resource.");

      const preview: Record<string, unknown> = { name, type, file: path, bytes: content.length, action: existing ? "update" : "create" };
      if (before && TEXT_WEB_RESOURCE_TYPES.has(type)) preview.diff = xmlDiff(before.toString("utf8").replace(/\r/g, ""), content.toString("utf8").replace(/\r/g, "")).slice(0, 80);

      return registerChange({
        tool: "webresource_upsert",
        env: ctx.envName(env),
        solution,
        summary: `${existing ? "Update" : "Create"} web resource ${name} from ${basename(path)}`,
        preview,
        execute: async () => {
          let wid: string;
          let snapshot: string | undefined;
          if (existing) {
            wid = existing.webresourceid;
            snapshot = saveSnapshot(ctx.envName(env), "webresource", wid, { kind: "webresource", id: wid, data: { content: existing.content } });
            await dv.patch(`webresourceset(${wid})`, { content: content.toString("base64") }, { solution });
            await dv.post("AddSolutionComponent", { ComponentId: wid, ComponentType: 61, SolutionUniqueName: solution, AddRequiredComponents: false }).catch(() => undefined);
          } else {
            const created = await dv.post(
              "webresourceset",
              { name, displayname: displayName ?? basename(name), webresourcetype: type, content: content.toString("base64") },
              { solution },
            );
            wid = created.id;
          }
          await publish(ctx, env, { webResourceIds: [wid] });
          return { webResourceId: wid, snapshot, published: true };
        },
      });
    }),
  );

  // ------------------------------------------------ rollback
  server.registerTool(
    "snapshot_restore_plan",
    {
      title: "Plan: restore snapshot",
      description: "Plan restoring a form, view or web resource from a snapshot file in backups/ (paths are returned by change_apply). Returns a changeToken.",
      inputSchema: { file: z.string(), env: envParam },
    },
    safe(async ({ file, env }) => {
      ctx.assertWritable(env);
      const solution = ctx.requireSolution(env);
      const snap = readSnapshot(resolve(file));
      const dv = ctx.dv(env);
      const targets: Record<string, { path: string; publish: () => Promise<void> }> = {
        systemform: { path: `systemforms(${snap.id})`, publish: () => publish(ctx, env, { entities: [snap.table!] }) },
        savedquery: { path: `savedqueries(${snap.id})`, publish: () => publish(ctx, env, { entities: [snap.table!] }) },
        webresource: { path: `webresourceset(${snap.id})`, publish: () => publish(ctx, env, { webResourceIds: [snap.id] }) },
      };
      const target = targets[snap.kind];
      if (!target) throw new Error(`Snapshot kind "${snap.kind}" is not restorable.`);
      return registerChange({
        tool: "snapshot_restore",
        env: ctx.envName(env),
        solution,
        summary: `Restore ${snap.kind} ${snap.id} from ${basename(file)}`,
        preview: { kind: snap.kind, id: snap.id, table: snap.table, fields: Object.keys(snap.data) },
        execute: async () => {
          // Snapshot the current state first so a restore can itself be undone.
          const current = await dv.get(`${target.path}?$select=${Object.keys(snap.data).join(",")}`);
          const before = saveSnapshot(ctx.envName(env), snap.kind, snap.id, {
            kind: snap.kind,
            id: snap.id,
            table: snap.table,
            data: Object.fromEntries(Object.keys(snap.data).map((k) => [k, current[k]])),
          });
          await dv.patch(target.path, snap.data, { solution });
          await target.publish();
          return { restored: true, snapshotOfReplacedState: before, published: true };
        },
      });
    }),
  );
}
