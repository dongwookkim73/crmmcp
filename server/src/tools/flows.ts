import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Context } from "../context.js";
import { odataString } from "../dataverse/client.js";
import {
  buildClientData,
  diffDefinitions,
  normalizeDefinition,
  outline,
  parseClientData,
  validateDefinition,
  type ConnectionReference,
  type FlowDefinition,
} from "../flows/definition.js";
import { registerChange, saveSnapshot } from "../pipeline/changes.js";
import { clean, envParam, safe } from "./util.js";

const id = z.string().regex(/^\{?[0-9a-fA-F-]{36}\}?$/, "GUID expected");
const bare = (g: string) => g.replace(/[{}]/g, "");

const DefinitionSchema = z
  .object({ triggers: z.record(z.string(), z.any()), actions: z.record(z.string(), z.any()) })
  .passthrough()
  .describe("Workflow definition: { triggers, actions } ($schema/parameters are filled in)");

const ConnectionsSchema = z
  .record(z.string(), z.string())
  .describe('connectionName used in actions -> connection reference logical name, e.g. { "shared_commondataserviceforapps": "dwmcp_dataverse" }');

const STATE = { 0: "Off (draft)", 1: "On", 2: "Suspended" } as Record<number, string>;

async function solutionFlowIds(ctx: Context, solution: string, env?: string): Promise<Set<string>> {
  const dv = ctx.dv(env);
  const sol = await dv.get(`solutions?$filter=uniquename eq ${odataString(solution)}&$select=solutionid`);
  if (!sol.value.length) throw new Error(`Solution "${solution}" not found.`);
  const comps = await dv.get(`solutioncomponents?$filter=_solutionid_value eq ${sol.value[0].solutionid} and componenttype eq 29&$select=objectid`);
  return new Set(comps.value.map((c: any) => String(c.objectid).toLowerCase()));
}

async function getFlow(ctx: Context, flowId: string, env?: string) {
  const f = await ctx.dv(env).get(
    `workflows(${bare(flowId)})?$select=workflowid,name,category,statecode,statuscode,clientdata,description,modifiedon,ismanaged`,
  );
  if (f.category !== 5) throw new Error(`Workflow ${flowId} is not a cloud flow (category ${f.category}).`);
  return f;
}

/** Turn { connectionName: referenceLogicalName } into full connectionReferences, checking each reference exists. */
async function resolveConnections(ctx: Context, connections: Record<string, string>, env?: string): Promise<Record<string, ConnectionReference>> {
  const refs: Record<string, ConnectionReference> = {};
  for (const [connectionName, logicalName] of Object.entries(connections)) {
    const res = await ctx.dv(env).get(
      `connectionreferences?$filter=connectionreferencelogicalname eq ${odataString(logicalName)}&$select=connectorid,connectionid`,
    );
    const ref = res.value[0];
    if (!ref) throw new Error(`Connection reference "${logicalName}" not found (see connref_list).`);
    refs[connectionName] = {
      runtimeSource: "embedded",
      connection: { connectionReferenceLogicalName: logicalName },
      api: { name: String(ref.connectorid ?? connectionName).split("/").pop()! },
    };
  }
  return refs;
}

function checked(def: FlowDefinition, refs: Record<string, ConnectionReference>) {
  const { errors, warnings } = validateDefinition(def, refs);
  if (errors.length) throw new Error(`Flow definition is invalid:\n- ${errors.join("\n- ")}`);
  return warnings;
}

export function registerFlowTools(server: McpServer, ctx: Context): void {
  server.registerTool(
    "flow_list",
    {
      title: "List cloud flows",
      description: "List solution-aware cloud flows (optionally only those in a solution) with state, trigger and last modified date.",
      inputSchema: {
        solution: z.string().optional().describe("Only flows in this solution"),
        nameContains: z.string().optional(),
        env: envParam,
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ solution, nameContains, env }) => {
      const filter = [`category eq 5`, nameContains ? `contains(name,${odataString(nameContains)})` : ""].filter(Boolean).join(" and ");
      const res = await ctx.dv(env).get(
        `workflows?$filter=${filter}&$select=workflowid,name,statecode,modifiedon,ismanaged,clientdata&$orderby=modifiedon desc&$top=200`,
      );
      const inSolution = solution ? await solutionFlowIds(ctx, solution, env) : undefined;
      return res.value
        .filter((f: any) => !inSolution || inSolution.has(String(f.workflowid).toLowerCase()))
        .map((f: any) => {
          let trigger = "?";
          try {
            trigger = outline(parseClientData(f.clientdata).properties.definition)[0]?.replace(/^TRIGGER /, "") ?? "?";
          } catch {
            // definition not readable
          }
          return { flowId: f.workflowid, name: f.name, state: STATE[f.statecode] ?? f.statecode, trigger, modifiedOn: f.modifiedon, managed: f.ismanaged };
        });
    }),
  );

  server.registerTool(
    "flow_get",
    {
      title: "Get cloud flow",
      description: "Show a flow's trigger and action outline (with branches and non-default runAfter), connection references, and validation warnings. Optionally include the raw definition JSON.",
      inputSchema: { flowId: id, includeDefinition: z.boolean().optional(), env: envParam },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ flowId, includeDefinition, env }) => {
      const f = await getFlow(ctx, flowId, env);
      const data = parseClientData(f.clientdata);
      const def = data.properties.definition;
      const { errors, warnings } = validateDefinition(def, data.properties.connectionReferences);
      return {
        flowId: f.workflowid,
        name: f.name,
        state: STATE[f.statecode] ?? f.statecode,
        managed: f.ismanaged,
        modifiedOn: f.modifiedon,
        outline: outline(def),
        connectionReferences: Object.fromEntries(
          Object.entries(data.properties.connectionReferences).map(([k, r]) => [k, `${r.connection?.connectionReferenceLogicalName} (${r.api?.name})`]),
        ),
        ...(errors.length ? { problems: errors } : {}),
        ...(warnings.length ? { warnings } : {}),
        ...(includeDefinition ? { definition: def } : {}),
      };
    }),
  );

  server.registerTool(
    "connref_list",
    {
      title: "List connection references",
      description: "List connection references (logical name, connector, whether a connection is set) to use in new or updated flows.",
      inputSchema: { nameContains: z.string().optional(), env: envParam },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ nameContains, env }) => {
      const filter = nameContains ? `&$filter=contains(connectionreferencelogicalname,${odataString(nameContains)})` : "";
      const res = await ctx.dv(env).get(
        `connectionreferences?$select=connectionreferencelogicalname,connectionreferencedisplayname,connectorid,connectionid,statecode${filter}&$orderby=connectionreferencelogicalname`,
      );
      return res.value.map((r: any) => ({
        logicalName: r.connectionreferencelogicalname,
        displayName: r.connectionreferencedisplayname,
        connector: String(r.connectorid ?? "").split("/").pop(),
        hasConnection: Boolean(r.connectionid),
        active: r.statecode === 0,
      }));
    }),
  );

  server.registerTool(
    "flow_create_plan",
    {
      title: "Plan: create cloud flow",
      description:
        "Plan a new solution-aware cloud flow from a definition ({ triggers, actions }) and connection mappings. The flow is created OFF; " +
        "turn it on with flow_set_state_plan after testing. Validates trigger count, runAfter references/cycles and connection references. Returns a changeToken.",
      inputSchema: {
        name: z.string(),
        description: z.string().optional(),
        definition: DefinitionSchema,
        connections: ConnectionsSchema.optional(),
        env: envParam,
      },
    },
    safe(async ({ name, description, definition, connections, env }) => {
      ctx.assertWritable(env);
      const solution = ctx.requireSolution(env);
      const def = normalizeDefinition(definition as FlowDefinition);
      const refs = connections ? await resolveConnections(ctx, connections, env) : {};
      const warnings = checked(def, refs);
      const clientdata = buildClientData(def, refs);
      return registerChange({
        tool: "flow_create",
        env: ctx.envName(env),
        solution,
        summary: `Create cloud flow "${name}" (off) in solution ${solution}`,
        preview: { name, outline: outline(def), connections: refs, ...(warnings.length ? { warnings } : {}) },
        execute: async () => {
          const res = await ctx.dv(env).post(
            "workflows",
            { category: 5, name, type: 1, primaryentity: "none", description: description ?? "", clientdata },
            { solution },
          );
          return { flowId: res.id, state: "Off", next: "Test it, then flow_set_state_plan to turn it on." };
        },
      });
    }),
  );

  server.registerTool(
    "flow_update_plan",
    {
      title: "Plan: update cloud flow",
      description:
        "Plan replacing a flow's definition (and optionally its connections or name). Shows added/removed/changed actions. " +
        "An active flow is turned off, updated and turned back on. Snapshot saved. Returns a changeToken.",
      inputSchema: {
        flowId: id,
        definition: DefinitionSchema.optional(),
        connections: ConnectionsSchema.optional().describe("Replaces/adds these connection mappings; others are kept"),
        name: z.string().optional(),
        env: envParam,
      },
    },
    safe(async ({ flowId, definition, connections, name, env }) => {
      ctx.assertWritable(env);
      const solution = ctx.requireSolution(env);
      const fid = bare(flowId);
      const f = await getFlow(ctx, fid, env);
      if (f.ismanaged) throw new Error("This flow is managed; change it in its source environment.");
      const current = parseClientData(f.clientdata);
      const before = current.properties.definition;
      const def = definition ? normalizeDefinition(definition as FlowDefinition) : before;
      const refs = { ...current.properties.connectionReferences, ...(connections ? await resolveConnections(ctx, connections, env) : {}) };
      const warnings = checked(def, refs);
      const clientdata = buildClientData(def, refs);
      const diff = diffDefinitions(before, def);
      if (!definition && !connections && (!name || name === f.name)) throw new Error("Nothing to change.");
      const wasOn = f.statecode === 1;

      return registerChange({
        tool: "flow_update",
        env: ctx.envName(env),
        solution,
        summary: `Update cloud flow "${f.name}": +${diff.added.length} -${diff.removed.length} ~${diff.changed.length} action(s)${wasOn ? " (off → update → on)" : ""}`,
        preview: { flow: f.name, ...(name && name !== f.name ? { rename: name } : {}), diff, outlineAfter: outline(def), ...(warnings.length ? { warnings } : {}) },
        execute: async () => {
          const dv = ctx.dv(env);
          const snapshot = saveSnapshot(ctx.envName(env), "flow", fid, { kind: "workflow", id: fid, data: { clientdata: f.clientdata, name: f.name } });
          if (wasOn) await dv.patch(`workflows(${fid})`, { statecode: 0, statuscode: 1 });
          try {
            await dv.patch(`workflows(${fid})`, { clientdata, ...(name ? { name } : {}) }, { solution });
          } finally {
            if (wasOn) await dv.patch(`workflows(${fid})`, { statecode: 1, statuscode: 2 });
          }
          return { snapshot, state: wasOn ? "On" : "Off" };
        },
      });
    }),
  );

  server.registerTool(
    "flow_set_state_plan",
    {
      title: "Plan: turn flow on/off",
      description: "Plan turning a cloud flow on or off. Turning on fails if a connection reference has no connection. Returns a changeToken.",
      inputSchema: { flowId: id, state: z.enum(["on", "off"]), env: envParam },
    },
    safe(async ({ flowId, state, env }) => {
      ctx.assertWritable(env);
      const fid = bare(flowId);
      const f = await getFlow(ctx, fid, env);
      const target = state === "on" ? 1 : 0;
      if (f.statecode === target) throw new Error(`Flow is already ${state}.`);
      if (state === "on") {
        const refs = parseClientData(f.clientdata).properties.connectionReferences;
        for (const r of Object.values(refs)) {
          const res = await ctx.dv(env).get(
            `connectionreferences?$filter=connectionreferencelogicalname eq ${odataString(r.connection.connectionReferenceLogicalName)}&$select=connectionid`,
          );
          if (!res.value[0]?.connectionid) throw new Error(`Connection reference ${r.connection.connectionReferenceLogicalName} has no connection; set it in the solution first.`);
        }
      }
      return registerChange({
        tool: "flow_set_state",
        env: ctx.envName(env),
        summary: `Turn ${state} cloud flow "${f.name}"`,
        preview: { flow: f.name, from: STATE[f.statecode], to: state === "on" ? "On" : "Off (draft)" },
        execute: async () => {
          await ctx.dv(env).patch(`workflows(${fid})`, state === "on" ? { statecode: 1, statuscode: 2 } : { statecode: 0, statuscode: 1 });
          return { state };
        },
      });
    }),
  );

  server.registerTool(
    "flow_runs",
    {
      title: "Recent flow runs",
      description: "Recent runs of a cloud flow from the Dataverse flow run table (status, start/end, error). Run history is only available where the environment stores it in Dataverse.",
      inputSchema: { flowId: id, top: z.number().int().min(1).max(50).default(10), env: envParam },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ flowId, top, env }) => {
      try {
        const res = await ctx.dv(env).get(`flowruns?$filter=_workflow_value eq ${bare(flowId)}&$orderby=createdon desc&$top=${top}`);
        return res.value.map((r: any) => {
          const row = clean(r);
          const pick = (...keys: string[]) => keys.map((k) => row[k]).find((v) => v !== undefined && v !== null);
          return {
            run: pick("name", "flowrunid"),
            status: pick("status@display", "status"),
            start: pick("starttime", "createdon"),
            end: pick("endtime"),
            durationMs: pick("duration"),
            error: pick("errormessage", "errorcode"),
          };
        });
      } catch (err) {
        throw new Error(`Flow run history isn't available through Dataverse here (${(err as Error).message.slice(0, 160)}). Use the flow's run history in make.powerautomate.com.`);
      }
    }),
  );
}
