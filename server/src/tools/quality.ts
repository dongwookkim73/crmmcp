import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DEFAULT_TAGS, scanUrls, summarizeScan, writeA11yReport } from "../a11y/scan.js";
import { staticA11y } from "../a11y/static.js";
import { ROOT_DIR } from "../config.js";
import type { Context } from "../context.js";
import { listEntities } from "../dataverse/metadata.js";
import { SEVERITY_ORDER, webApiTables } from "../pages/audit.js";
import { liveCheck } from "../pages/live.js";
import { resolveSite } from "../pages/site.js";
import { envParam, safe } from "./util.js";

export function registerQualityTools(server: McpServer, ctx: Context): void {
  server.registerTool(
    "a11y_scan",
    {
      title: "Accessibility scan (live)",
      description:
        "Scan public pages with axe-core in headless Edge/Chrome against WCAG 2.x A/AA. Optionally crawl same-site links up to N pages. " +
        "Writes reports/a11y-<host>-<date>.md (+ .json). Pages behind sign-in are not covered.",
      inputSchema: {
        urls: z.array(z.string().url()).min(1),
        crawl: z.number().int().min(1).max(50).optional().describe("Follow same-site links until this many pages are scanned"),
        tags: z.array(z.string()).optional().describe(`axe tags (default ${DEFAULT_TAGS.join(", ")})`),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async ({ urls, crawl, tags }) => {
      const results = await scanUrls(urls, { crawl, tags });
      const report = writeA11yReport(results, new URL(urls[0]).hostname);
      const summary = summarizeScan(results);
      return {
        ...summary,
        rules: summary.rules.slice(0, 30),
        pages: results.map((r) => ({ url: r.url, title: r.title, violations: r.violations.length, ...(r.error ? { error: r.error } : {}) })),
        report,
      };
    }),
  );

  server.registerTool(
    "a11y_static",
    {
      title: "Accessibility lint (templates)",
      description:
        "Static accessibility lint of a downloaded Power Pages site's HTML/Liquid: missing alt, empty links/buttons, html lang, " +
        "positive tabindex, clickable divs, placeholder-only inputs, zoom disabled, iframe titles, autoplay, skipped heading levels.",
      inputSchema: { site: z.string().describe("Local site folder under src/pages or a path") },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ site }) => {
      const issues = staticA11y(resolveSite(site));
      const byRule: Record<string, number> = {};
      for (const i of issues) byRule[i.rule] = (byRule[i.rule] ?? 0) + 1;
      return { total: issues.length, byRule, issues: issues.slice(0, 60), ...(issues.length > 60 ? { more: issues.length - 60 } : {}) };
    }),
  );

  server.registerTool(
    "pages_security_live",
    {
      title: "Power Pages live security check",
      description:
        "Read-only checks against a deployed site you own: security headers, cookie flags, public/private visibility, /_services/about, " +
        "and anonymous GET /_api/<table>?$top=1 for Web API-enabled tables (taken from the downloaded site and/or the tables list). " +
        "Requires confirmOwnSite: true.",
      inputSchema: {
        siteUrl: z.string().url().describe("https://<site>.powerappsportals.com or custom domain"),
        confirmOwnSite: z.literal(true).describe("Confirms this is the user's own site and they asked for the check"),
        site: z.string().optional().describe("Local downloaded site, to read which tables have the Web API enabled"),
        tables: z.array(z.string()).optional().describe("Extra table logical names to probe"),
        env: envParam,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async ({ siteUrl, site, tables, env }) => {
      const wanted = [...new Set([...(site ? webApiTables(resolveSite(site)) : []), ...(tables ?? [])].map((t) => t.toLowerCase()))];
      const entities = wanted.length ? await listEntities(ctx, env) : [];
      const probes = wanted.map((t) => {
        const e = entities.find((x) => x.logicalName === t);
        if (!e) throw new Error(`Table "${t}" not found in environment ${ctx.envName(env)}.`);
        return { table: t, entitySet: e.entitySetName };
      });
      const result = await liveCheck(siteUrl, probes);
      result.findings.sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));

      const dir = resolve(ROOT_DIR, "reports");
      mkdirSync(dir, { recursive: true });
      const report = resolve(dir, `pages-live-${new URL(siteUrl).hostname}-${new Date().toISOString().slice(0, 10)}.json`);
      writeFileSync(report, JSON.stringify(result, null, 2));
      return { ...result, report };
    }),
  );
}
