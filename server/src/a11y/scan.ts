import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { chromium, type Browser } from "playwright-core";
import { ROOT_DIR } from "../config.js";
import { log } from "../log.js";

export const DEFAULT_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/** Use an installed Edge/Chrome so no browser download is needed. */
async function launch(): Promise<Browser> {
  const errors: string[] = [];
  for (const channel of ["msedge", "chrome", undefined]) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch (err) {
      errors.push(`${channel ?? "bundled chromium"}: ${(err as Error).message.split("\n")[0]}`);
    }
  }
  throw new Error(`No usable browser found (install Microsoft Edge or Chrome):\n${errors.join("\n")}`);
}

export interface PageResult {
  url: string;
  title?: string;
  error?: string;
  violations: { id: string; impact: string; help: string; helpUrl: string; nodes: number; targets: string[]; wcag: string[] }[];
  passes: number;
  incomplete: number;
}

export async function scanUrls(urls: string[], options: { tags?: string[]; crawl?: number } = {}): Promise<PageResult[]> {
  const browser = await launch();
  const results: PageResult[] = [];
  const queue = [...urls];
  const seen = new Set<string>();
  const origin = new URL(urls[0]).origin;
  const maxPages = Math.max(urls.length, options.crawl ?? 0);
  try {
    const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    while (queue.length && results.length < maxPages) {
      const url = queue.shift()!;
      const key = url.replace(/#.*$/, "").replace(/\/$/, "");
      if (seen.has(key)) continue;
      seen.add(key);
      const page = await context.newPage();
      try {
        log("a11y scan", url);
        await page.goto(url, { waitUntil: "networkidle", timeout: 45_000 });
        if (options.crawl) {
          const links = await page.$$eval("a[href]", (as) => as.map((a) => (a as HTMLAnchorElement).href));
          for (const l of links) if (l.startsWith(origin) && !/\.(pdf|docx?|xlsx?|zip|png|jpe?g)$/i.test(l) && !l.includes("/_")) queue.push(l);
        }
        const axe = await new AxeBuilder({ page }).withTags(options.tags ?? DEFAULT_TAGS).analyze();
        results.push({
          url,
          title: await page.title(),
          violations: axe.violations.map((v) => ({
            id: v.id,
            impact: v.impact ?? "unknown",
            help: v.help,
            helpUrl: v.helpUrl,
            nodes: v.nodes.length,
            targets: v.nodes.slice(0, 5).map((n) => n.target.join(" ")),
            wcag: v.tags.filter((t) => /^wcag\d/.test(t)),
          })),
          passes: axe.passes.length,
          incomplete: axe.incomplete.length,
        });
      } catch (err) {
        results.push({ url, error: (err as Error).message.split("\n")[0], violations: [], passes: 0, incomplete: 0 });
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
  return results;
}

const IMPACT_ORDER = ["critical", "serious", "moderate", "minor", "unknown"];

export function summarizeScan(results: PageResult[]) {
  const byRule = new Map<string, { id: string; impact: string; help: string; helpUrl: string; pages: number; nodes: number; wcag: string[] }>();
  for (const r of results) {
    for (const v of r.violations) {
      const e = byRule.get(v.id) ?? { id: v.id, impact: v.impact, help: v.help, helpUrl: v.helpUrl, pages: 0, nodes: 0, wcag: v.wcag };
      e.pages += 1;
      e.nodes += v.nodes;
      byRule.set(v.id, e);
    }
  }
  const rules = [...byRule.values()].sort((a, b) => IMPACT_ORDER.indexOf(a.impact) - IMPACT_ORDER.indexOf(b.impact) || b.nodes - a.nodes);
  const counts = Object.fromEntries(IMPACT_ORDER.slice(0, 4).map((i) => [i, rules.filter((r) => r.impact === i).length]));
  return { pagesScanned: results.length, pagesFailed: results.filter((r) => r.error).length, rulesViolated: rules.length, counts, rules };
}

export function writeA11yReport(results: PageResult[], label: string): string {
  const dir = resolve(ROOT_DIR, "reports");
  mkdirSync(dir, { recursive: true });
  const base = resolve(dir, `a11y-${label}-${new Date().toISOString().slice(0, 10)}`);
  const s = summarizeScan(results);
  const lines = [
    `# Accessibility scan — ${label}`,
    "",
    `Generated ${new Date().toISOString()} · axe-core · tags ${DEFAULT_TAGS.join(", ")}`,
    "",
    `Pages scanned: ${s.pagesScanned} (failed to load: ${s.pagesFailed}) · Rules violated: ${s.rulesViolated}`,
    "",
    "| Impact | Rules |",
    "|---|---|",
    ...Object.entries(s.counts).map(([k, v]) => `| ${k} | ${v} |`),
    "",
    "## Rules",
    "",
    "| Impact | Rule | Pages | Elements | WCAG | Help |",
    "|---|---|---|---|---|---|",
    ...s.rules.map((r) => `| ${r.impact} | \`${r.id}\` | ${r.pages} | ${r.nodes} | ${r.wcag.join(" ")} | [${r.help}](${r.helpUrl}) |`),
    "",
    "## Pages",
    "",
  ];
  for (const r of results) {
    lines.push(`### ${r.title ? `${r.title} — ` : ""}${r.url}`, "");
    if (r.error) lines.push(`Failed to load: ${r.error}`, "");
    for (const v of r.violations) lines.push(`- **${v.impact}** \`${v.id}\` (${v.nodes}): ${v.help} — e.g. \`${v.targets[0] ?? ""}\``);
    lines.push("");
  }
  writeFileSync(`${base}.md`, lines.join("\n"));
  writeFileSync(`${base}.json`, JSON.stringify(results, null, 2));
  return `${base}.md`;
}
