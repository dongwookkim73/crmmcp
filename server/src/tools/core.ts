import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Context } from "../context.js";
import { odataString } from "../dataverse/client.js";
import { applyChange, discardChange, listChanges, registerChange } from "../pipeline/changes.js";
import { clean, envParam, safe } from "./util.js";

const COMPONENT_TYPES: Record<number, string> = {
  1: "Entity",
  2: "Attribute",
  9: "OptionSet",
  10: "EntityRelationship",
  14: "EntityKey",
  20: "Role",
  26: "View (SavedQuery)",
  29: "Workflow / Cloud flow",
  59: "Chart",
  60: "Form (SystemForm)",
  61: "WebResource",
  62: "SiteMap",
  66: "CustomControl (PCF)",
  80: "Model-driven app",
  300: "Canvas app",
  371: "Connector",
  380: "Environment variable definition",
  10000: "Connection reference (or other solution-aware table)",
};

/** Customization option value prefix must be 10000-99999; derive a stable one from the prefix. */
function optionValuePrefix(prefix: string): number {
  let hash = 0;
  for (const ch of prefix) hash = (hash * 31 + ch.charCodeAt(0)) % 90000;
  return 10000 + hash;
}

export function registerCoreTools(server: McpServer, ctx: Context): void {
  server.registerTool(
    "env_info",
    {
      title: "Environment info",
      description: "Show the connected Dataverse environment, signed-in user, version, working solution, publisher prefix and whether writes are allowed. Call this first in a session.",
      inputSchema: { env: envParam },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ env }) => {
      const dv = ctx.dv(env);
      const who = await dv.get("WhoAmI");
      const [user, version] = await Promise.all([
        dv.get(`systemusers(${who.UserId})?$select=fullname,domainname`),
        dv.get("RetrieveVersion"),
      ]);
      return {
        environment: ctx.envName(env),
        url: ctx.env(env).url,
        version: version.Version,
        user: { name: user.fullname, upn: user.domainname, id: who.UserId },
        organizationId: who.OrganizationId,
        workingSolution: ctx.solution(env) ?? null,
        publisherPrefix: ctx.config.publisherPrefix,
        readOnly: ctx.env(env).readOnly,
      };
    }),
  );

  server.registerTool(
    "solution_list",
    {
      title: "List unmanaged solutions",
      description: "List visible unmanaged solutions with version and publisher prefix.",
      inputSchema: { env: envParam },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ env }) => {
      const res = await ctx.dv(env).get(
        "solutions?$filter=ismanaged eq false and isvisible eq true" +
          "&$select=uniquename,friendlyname,version,modifiedon" +
          "&$expand=publisherid($select=uniquename,customizationprefix)&$orderby=modifiedon desc",
      );
      return res.value.map((s: any) => ({
        uniqueName: s.uniquename,
        name: s.friendlyname,
        version: s.version,
        publisher: s.publisherid?.uniquename,
        prefix: s.publisherid?.customizationprefix,
        modifiedOn: s.modifiedon,
      }));
    }),
  );

  server.registerTool(
    "solution_components",
    {
      title: "List solution components",
      description: "List components in a solution grouped by type (tables, columns, forms, views, flows, web resources, PCF...).",
      inputSchema: {
        solution: z.string().optional().describe("Solution unique name (default: working solution)"),
        env: envParam,
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ solution, env }) => {
      const name = solution ?? ctx.requireSolution(env);
      const dv = ctx.dv(env);
      const sol = await dv.get(`solutions?$filter=uniquename eq ${odataString(name)}&$select=solutionid`);
      if (!sol.value.length) throw new Error(`Solution "${name}" not found.`);
      const res = await dv.get(
        `solutioncomponents?$filter=_solutionid_value eq ${sol.value[0].solutionid}` +
          "&$select=componenttype,objectid,rootcomponentbehavior",
      );
      const groups: Record<string, string[]> = {};
      for (const c of res.value) {
        const type = COMPONENT_TYPES[c.componenttype] ?? `Type ${c.componenttype}`;
        (groups[type] ??= []).push(c.objectid);
      }
      return { solution: name, total: res.value.length, components: groups };
    }),
  );

  server.registerTool(
    "solution_set_active",
    {
      title: "Set working solution",
      description: "Set the unmanaged solution that new and changed components are added to for the rest of this session.",
      inputSchema: { solution: z.string().describe("Solution unique name"), env: envParam },
    },
    safe(async ({ solution, env }) => {
      const res = await ctx.dv(env).get(
        `solutions?$filter=uniquename eq ${odataString(solution)}&$select=ismanaged`,
      );
      if (!res.value.length) throw new Error(`Solution "${solution}" not found. Use solution_create_plan to create it.`);
      if (res.value[0].ismanaged) throw new Error(`Solution "${solution}" is managed and cannot be customized.`);
      ctx.setSolution(env, solution);
      return { environment: ctx.envName(env), workingSolution: solution };
    }),
  );

  server.registerTool(
    "solution_create_plan",
    {
      title: "Plan: create solution",
      description: "Plan creating an unmanaged solution under the configured publisher prefix (the publisher is created too if missing). Returns a changeToken for change_apply.",
      inputSchema: {
        uniqueName: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("Solution unique name, e.g. dwmcp_core"),
        friendlyName: z.string().describe("Display name"),
        version: z.string().default("1.0.0.0"),
        env: envParam,
      },
    },
    safe(async ({ uniqueName, friendlyName, version, env }) => {
      ctx.assertWritable(env);
      const dv = ctx.dv(env);
      const prefix = ctx.config.publisherPrefix;
      const existing = await dv.get(`solutions?$filter=uniquename eq ${odataString(uniqueName)}&$select=solutionid`);
      if (existing.value.length) throw new Error(`Solution "${uniqueName}" already exists.`);

      const pubs = await dv.get(
        `publishers?$filter=customizationprefix eq ${odataString(prefix)}&$select=publisherid,uniquename,friendlyname`,
      );
      const publisher = pubs.value[0];
      const newPublisher = publisher
        ? undefined
        : {
            uniquename: prefix,
            friendlyname: prefix.toUpperCase(),
            customizationprefix: prefix,
            customizationoptionvalueprefix: optionValuePrefix(prefix),
          };

      return registerChange({
        tool: "solution_create",
        env: ctx.envName(env),
        summary: `Create solution "${uniqueName}" (publisher prefix "${prefix}")`,
        preview: {
          publisher: publisher ? { existing: publisher.uniquename } : { create: newPublisher },
          solution: { uniquename: uniqueName, friendlyname: friendlyName, version },
        },
        execute: async () => {
          const publisherId = publisher ? publisher.publisherid : (await dv.post("publishers", newPublisher)).id;
          const created = await dv.post("solutions", {
            uniquename: uniqueName,
            friendlyname: friendlyName,
            version,
            "publisherid@odata.bind": `/publishers(${publisherId})`,
          });
          ctx.setSolution(env, uniqueName);
          return { solutionId: created.id, workingSolution: uniqueName };
        },
      });
    }),
  );

  server.registerTool(
    "change_apply",
    {
      title: "Apply planned change",
      description: "Execute a change previously returned by a *_plan tool. Only call after the user has reviewed and approved the preview.",
      inputSchema: { changeToken: z.string() },
      annotations: { destructiveHint: true },
    },
    safe(async ({ changeToken }) => applyChange(changeToken)),
  );

  server.registerTool(
    "change_list",
    {
      title: "List pending changes",
      description: "List planned changes that have not been applied yet (they expire after 10 minutes).",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    safe(async () => listChanges()),
  );

  server.registerTool(
    "change_discard",
    {
      title: "Discard planned change",
      description: "Discard a planned change without applying it.",
      inputSchema: { changeToken: z.string() },
    },
    safe(async ({ changeToken }) => ({ discarded: discardChange(changeToken) })),
  );

  server.registerTool(
    "publish_all",
    {
      title: "Publish all customizations",
      description: "Publish all customizations in the environment (PublishAllXml). Prefer publishing specific components when a tool offers it.",
      inputSchema: { env: envParam },
    },
    safe(async ({ env }) => {
      ctx.assertWritable(env);
      await ctx.dv(env).post("PublishAllXml", {});
      return { published: true, environment: ctx.envName(env) };
    }),
  );

  server.registerTool(
    "dv_get",
    {
      title: "Read Dataverse (GET)",
      description: "Run a read-only Web API GET relative to /api/data/v9.2/, e.g. \"accounts?$select=name&$top=5\" or \"EntityDefinitions(LogicalName='account')\". Results are capped at limits.maxRows.",
      inputSchema: { path: z.string().describe("Relative Web API path with query options"), env: envParam },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ path, env }) => {
      if (/^https?:/i.test(path)) throw new Error("Pass a path relative to /api/data/v9.2/, not a full URL.");
      const res = await ctx.dv(env).get(path, {
        headers: { Prefer: `odata.include-annotations="*",odata.maxpagesize=${ctx.config.limits.maxRows}` },
      });
      if (!Array.isArray(res.value)) return clean(res);
      return {
        count: res.value.length,
        truncated: Boolean(res["@odata.nextLink"]),
        rows: res.value.map(clean),
      };
    }),
  );
}
