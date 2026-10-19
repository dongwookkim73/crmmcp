import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import YAML from "yaml";
import { ROOT_DIR } from "../config.js";

/** Local working copies of Power Pages sites (downloaded with pac pages download). */
export const PAGES_DIR = resolve(ROOT_DIR, "src", "pages");
const BASELINE_DIR = resolve(ROOT_DIR, "backups", "pages-baseline");

export const TEXT_EXTENSIONS = new Set([".yml", ".yaml", ".html", ".htm", ".js", ".css", ".liquid", ".json", ".txt", ".xml", ".svg", ".md"]);

export function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/** The folder that contains website.yml is the uploadable site root. */
export function findSiteRoot(dir: string): string | undefined {
  if (existsSync(join(dir, "website.yml"))) return dir;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const found = findSiteRoot(join(dir, entry.name));
      if (found) return found;
    }
  }
  return undefined;
}

/** List downloaded sites: { folder name -> site root }. */
export function localSites(): Record<string, string> {
  if (!existsSync(PAGES_DIR)) return {};
  const sites: Record<string, string> = {};
  for (const entry of readdirSync(PAGES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const root = findSiteRoot(join(PAGES_DIR, entry.name));
    if (root) sites[entry.name] = root;
  }
  return sites;
}

/** Resolve a site by local folder name or an explicit path. */
export function resolveSite(site: string): string {
  const sites = localSites();
  if (sites[site]) return sites[site];
  const match = Object.entries(sites).find(([name]) => name.toLowerCase() === site.toLowerCase());
  if (match) return match[1];
  if (existsSync(site) && statSync(site).isDirectory()) {
    const root = findSiteRoot(resolve(site));
    if (root) return root;
  }
  const known = Object.keys(sites);
  throw new Error(`Local site "${site}" not found.${known.length ? ` Downloaded sites: ${known.join(", ")}` : " Use pages_download first."}`);
}

export function slug(name: string): string {
  return name.replace(/[^A-Za-z0-9-_]+/g, "-").replace(/^-+|-+$/g, "") || "site";
}

// ---------------------------------------------------------------- baseline (for diffs)

type Manifest = Record<string, string>;

function hashFile(path: string): string {
  return createHash("sha1").update(readFileSync(path)).digest("hex");
}

function manifest(root: string): Manifest {
  const m: Manifest = {};
  for (const file of walk(root)) m[relative(root, file).split(sep).join("/")] = hashFile(file);
  return m;
}

function baselinePath(root: string): string {
  return join(BASELINE_DIR, createHash("sha1").update(root.toLowerCase()).digest("hex").slice(0, 12));
}

/** Record the current files as the baseline (after download/upload); keeps text copies for line diffs. */
export function saveBaseline(root: string): void {
  const dir = baselinePath(root);
  mkdirSync(join(dir, "files"), { recursive: true });
  const m = manifest(root);
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ root, savedAt: new Date().toISOString(), files: m }, null, 2));
  for (const rel of Object.keys(m)) {
    if (!TEXT_EXTENSIONS.has(ext(rel))) continue;
    const target = join(dir, "files", rel);
    mkdirSync(resolve(target, ".."), { recursive: true });
    writeFileSync(target, readFileSync(join(root, rel)));
  }
}

function ext(path: string): string {
  const i = path.lastIndexOf(".");
  return i < 0 ? "" : path.slice(i).toLowerCase();
}

export interface SiteDiff {
  baselineAt?: string;
  added: string[];
  modified: string[];
  deleted: string[];
}

export function diffAgainstBaseline(root: string): SiteDiff {
  const file = join(baselinePath(root), "manifest.json");
  if (!existsSync(file)) return { added: [], modified: [], deleted: [] };
  const base = JSON.parse(readFileSync(file, "utf8"));
  const now = manifest(root);
  const before: Manifest = base.files;
  return {
    baselineAt: base.savedAt,
    added: Object.keys(now).filter((f) => !(f in before)),
    modified: Object.keys(now).filter((f) => f in before && before[f] !== now[f]),
    deleted: Object.keys(before).filter((f) => !(f in now)),
  };
}

/** Baseline text of a file, for showing line diffs of modified files. */
export function baselineText(root: string, rel: string): string | undefined {
  const path = join(baselinePath(root), "files", rel);
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

/** Group a site-relative path into a component category (web-pages, web-templates, table-permissions, ...). */
export function category(rel: string): string {
  return rel.includes("/") ? rel.split("/")[0] : "site";
}

// ---------------------------------------------------------------- YAML loading

/** Normalize YAML keys: lowercase and strip adx_/mspp_ prefixes so both data models read the same. */
export function normalizeKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k.toLowerCase().replace(/^(adx_|mspp_)/, "")] = normalizeKeys(v);
    return out;
  }
  return value;
}

export interface YamlDoc {
  rel: string;
  data: any;
}

export function loadYaml(root: string): YamlDoc[] {
  const docs: YamlDoc[] = [];
  for (const file of walk(root)) {
    if (!/\.ya?ml$/i.test(file)) continue;
    const rel = relative(root, file).split(sep).join("/");
    try {
      docs.push({ rel, data: normalizeKeys(YAML.parse(readFileSync(file, "utf8"))) });
    } catch {
      docs.push({ rel, data: undefined });
    }
  }
  return docs;
}
