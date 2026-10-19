import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Context } from "../context.js";
import { pacOrThrow, tail } from "../pac/run.js";
import { auditSite, DEFAULT_SENSITIVE_TABLES, writeAuditReport, type AuditResult } from "../pages/audit.js";
import {
  baselineText,
  category,
  diffAgainstBaseline,
  findSiteRoot,
  localSites,
  PAGES_DIR,
  resolveSite,
  saveBaseline,
  TEXT_EXTENSIONS,
  walk,
} from "../pages/site.js";
import { registerChange } from "../pipeline/changes.js";
import { audit as auditLog } from "../log.js";
import { envParam, safe } from "./util.js";

const siteParam = z.string().describe("Local site folder name under src/pages (see pages_local_list) or a path");

interface RemoteSite {
  id: string;
  name: string;
  model: "Enhanced" | "Standard";
}

async function remoteSites(ctx: Context, env?: string): Promise<RemoteSite[]> {
  const dv = ctx.dv(env);
  const sites: RemoteSite[] = [];
  try {
    const res = await dv.get("powerpagesites?$select=powerpagesiteid,name&$orderby=name");
    sites.push(...res.value.map((s: any) => ({ id: s.powerpagesiteid, name: s.name, model: "Enhanced" as const })));
  } catch {
    // enhanced data model tables not installed
  }
  try {
    const res = await dv.get("adx_websites?$select=adx_websiteid,adx_name&$orderby=adx_name");
    sites.push(...res.value.map((s: any) => ({ id: s.adx_websiteid, name: s.adx_name, model: "Standard" as const })));
  } catch {
    // standard data model not installed
  }
  return sites;
}

/** Changed lines between two texts (order-insensitive, capped) for previews. */
function lineDiff(before: string, after: string, max = 40): string[] {
  const a = before.replace(/\r/g, "").split("\n");
  const b = after.replace(/\r/g, "").split("\n");
  const setA = new Set(a);
  const setB = new Set(b);
  const out = [...a.filter((l) => !setB.has(l)).map((l) => `- ${l}`), ...b.filter((l) => !setA.has(l)).map((l) => `+ ${l}`)];
  return out.length > max ? [...out.slice(0, max), `... ${out.length - max} more`] : out;
}

function group(files: string[]): Record<string, string[]> {
  const g: Record<string, string[]> = {};
  for (const f of files) (g[category(f)] ??= []).push(f);
  return g;
}

function sensitiveTables(ctx: Context): string[] {
  return [...DEFAULT_SENSITIVE_TABLES, ...ctx.config.pages.sensitiveTables];
}

function auditSummary(result: AuditResult, report: string, limit = 40) {
  return {
    site: result.site,
    counts: result.counts,
    inventory: result.inventory,
    warnings: result.warnings,
    report,
    findings: result.findings.slice(0, limit).map((f) => ({
      severity: f.severity,
      rule: f.rule,
      title: f.title,
      where: f.file ? `${f.file}${f.line ? `:${f.line}` : ""}` : undefined,
      detail: f.detail,
      fix: f.fix,
    })),
    ...(result.findings.length > limit ? { more: `${result.findings.length - limit} more in the report` } : {}),
  };
}

export function registerPagesTools(server: McpServer, ctx: Context): void {
  server.registerTool(
    "pages_list",
    {
      title: "List Power Pages sites",
      description: "List Power Pages sites in the environment (enhanced and standard data model) and whether each is downloaded locally.",
      inputSchema: { env: envParam },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ env }) => {
      const sites = await remoteSites(ctx, env);
      const local = localSites();
      return sites.map((s) => ({
        ...s,
        localFolder: Object.entries(local).find(([, root]) => readFileSync(join(root, "website.yml"), "utf8").toLowerCase().includes(s.id.toLowerCase()))?.[0] ?? null,
      }));
    }),
  );

  server.registerTool(
    "pages_download",
    {
      title: "Download Power Pages site",
      description:
        "Download a site with pac pages download into src/pages/ and record a baseline for pages_diff. " +
        "Requires a pac auth profile (pac auth create --environment <url>) once. Overwrites local changes only when overwrite is true.",
      inputSchema: {
        site: z.string().describe("Site name or ID (from pages_list)"),
        overwrite: z.boolean().optional(),
        env: envParam,
      },
    },
    safe(async ({ site, overwrite, env }) => {
      const sites = await remoteSites(ctx, env);
      const target = sites.find((s) => s.id.toLowerCase() === site.toLowerCase().replace(/[{}]/g, "")) ?? sites.find((s) => s.name.toLowerCase() === site.toLowerCase());
      if (!target) throw new Error(`Site "${site}" not found. Sites: ${sites.map((s) => s.name).join(", ") || "(none)"}`);

      mkdirSync(PAGES_DIR, { recursive: true });
      const before = new Set(readdirSync(PAGES_DIR));
      const existing = Object.entries(localSites()).find(([, root]) => readFileSync(join(root, "website.yml"), "utf8").toLowerCase().includes(target.id.toLowerCase()));
      if (existing && !overwrite) {
        const diff = diffAgainstBaseline(existing[1]);
        const pending = diff.added.length + diff.modified.length + diff.deleted.length;
        throw new Error(`Site is already downloaded to src/pages/${existing[0]}${pending ? ` with ${pending} local change(s)` : ""}. Pass overwrite: true to replace it.`);
      }

      const out = await pacOrThrow(
        ["pages", "download", "--environment", ctx.env(env).url, "--path", PAGES_DIR, "--webSiteId", target.id, "--modelVersion", target.model, ...(overwrite ? ["--overwrite"] : [])],
        { timeoutMs: 900_000 },
      );

      const created = readdirSync(PAGES_DIR).filter((d) => !before.has(d));
      const folder = existing?.[0] ?? created.find((d) => statSync(join(PAGES_DIR, d)).isDirectory());
      const root = folder ? findSiteRoot(join(PAGES_DIR, folder)) : undefined;
      if (!root) throw new Error(`Download finished but no website.yml was found under src/pages.\n${tail(out, 15)}`);
      saveBaseline(root);
      const files = walk(root);
      return { site: target.name, model: target.model, localFolder: folder, root, files: files.length, components: Object.fromEntries(Object.entries(group(files.map((f) => relative(root, f).split(sep).join("/")))).map(([k, v]) => [k, v.length])) };
    }),
  );

  server.registerTool(
    "pages_local_list",
    {
      title: "List downloaded sites",
      description: "List sites downloaded under src/pages with the number of local changes since download/upload.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    safe(async () =>
      Object.entries(localSites()).map(([name, root]) => {
        const d = diffAgainstBaseline(root);
        return { site: name, root, baselineAt: d.baselineAt ?? null, added: d.added.length, modified: d.modified.length, deleted: d.deleted.length };
      }),
    ),
  );

  server.registerTool(
    "pages_diff",
    {
      title: "Local site changes",
      description: "Show files added/modified/deleted since the last download or upload, grouped by component type, with changed lines for text files.",
      inputSchema: { site: siteParam, showLines: z.boolean().optional().describe("Include changed lines (default true)") },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ site, showLines }) => {
      const root = resolveSite(site);
      const d = diffAgainstBaseline(root);
      if (!d.baselineAt) throw new Error("No baseline for this site (download it with pages_download first).");
      const lines: Record<string, string[]> = {};
      if (showLines !== false) {
        for (const rel of d.modified.slice(0, 20)) {
          const before = baselineText(root, rel);
          if (before === undefined) continue;
          lines[rel] = lineDiff(before, readFileSync(join(root, rel), "utf8"));
        }
      }
      return { baselineAt: d.baselineAt, added: group(d.added), modified: group(d.modified), deleted: group(d.deleted), changedLines: lines };
    }),
  );

  server.registerTool(
    "pages_find",
    {
      title: "Search site files",
      description: "Search the downloaded site's files (templates, pages, snippets, settings, permissions) for text or a regex.",
      inputSchema: { site: siteParam, query: z.string(), regex: z.boolean().optional() },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ site, query, regex }) => {
      const root = resolveSite(site);
      const re = regex ? new RegExp(query, "i") : undefined;
      const q = query.toLowerCase();
      const hits: string[] = [];
      for (const file of walk(root)) {
        const dot = file.lastIndexOf(".");
        if (dot < 0 || !TEXT_EXTENSIONS.has(file.slice(dot).toLowerCase())) continue;
        const rel = relative(root, file).split(sep).join("/");
        readFileSync(file, "utf8").split(/\r?\n/).forEach((line, i) => {
          if (hits.length < 100 && (re ? re.test(line) : line.toLowerCase().includes(q))) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 160)}`);
        });
      }
      return { count: hits.length, truncated: hits.length >= 100, hits };
    }),
  );

  server.registerTool(
    "pages_security_audit",
    {
      title: "Power Pages security audit",
      description:
        "Static security audit of a downloaded site: anonymous/global table permissions, Web API exposure, open registration, " +
        "CSP/CORS/clickjacking headers, secrets in settings or code, forms/lists without table permissions, unprotected internal pages, " +
        "unescaped Liquid output. Writes a Markdown report to reports/.",
      inputSchema: { site: siteParam },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ site }) => {
      const result = auditSite(resolveSite(site), sensitiveTables(ctx));
      return auditSummary(result, writeAuditReport(result));
    }),
  );

  server.registerTool(
    "pages_upload_plan",
    {
      title: "Plan: upload site",
      description:
        "Plan uploading local site changes with pac pages upload. Runs the security audit first and refuses when critical findings exist " +
        "(unless acceptRiskReason is given). Returns the change list, audit summary and a changeToken for change_apply.",
      inputSchema: {
        site: siteParam,
        forceUploadAll: z.boolean().optional().describe("Upload every file, not only changed ones"),
        acceptRiskReason: z.string().optional().describe("Explicit reason to upload despite critical findings (logged)"),
        env: envParam,
      },
    },
    safe(async ({ site, forceUploadAll, acceptRiskReason, env }) => {
      ctx.assertWritable(env);
      const root = resolveSite(site);
      const diff = diffAgainstBaseline(root);
      const changes = diff.added.length + diff.modified.length + diff.deleted.length;
      if (!changes && !forceUploadAll) throw new Error("No local changes since the last download/upload.");

      const result = auditSite(root, sensitiveTables(ctx));
      const report = writeAuditReport(result);
      if (result.counts.critical > 0 && !acceptRiskReason) {
        return {
          blocked: true,
          reason: `${result.counts.critical} critical security finding(s). Fix them, or re-plan with acceptRiskReason.`,
          audit: auditSummary(result, report, 20),
        };
      }
      const modelVersion = ctx.config.pages.modelVersion;

      return registerChange({
        tool: "pages_upload",
        env: ctx.envName(env),
        summary: `Upload site ${relative(PAGES_DIR, root) || root} (${changes} changed file(s)${forceUploadAll ? ", force all" : ""})`,
        preview: {
          site: root,
          modelVersion,
          added: group(diff.added),
          modified: group(diff.modified),
          deleted: diff.deleted.length ? { note: "pac pages upload does not delete remote records for deleted files", files: diff.deleted } : [],
          audit: { counts: result.counts, report, ...(acceptRiskReason ? { acceptedRisk: acceptRiskReason } : {}) },
        },
        execute: async () => {
          if (acceptRiskReason) auditLog({ event: "pages_upload_risk_accepted", site: root, reason: acceptRiskReason, critical: result.counts.critical });
          const out = await pacOrThrow(
            ["pages", "upload", "--environment", ctx.env(env).url, "--path", root, "--modelVersion", modelVersion, ...(forceUploadAll ? ["--forceUploadAll"] : [])],
            { timeoutMs: 900_000 },
          );
          saveBaseline(root);
          return { uploaded: true, output: tail(out, 15), note: "Clear the site cache (Power Pages design studio → Sync, or /_services/about → Clear cache) if changes don't show." };
        },
      });
    }),
  );
}
