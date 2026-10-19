import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ROOT_DIR } from "../config.js";
import { parseXml, serialize } from "../dataverse/formxml.js";

/** PCF projects live under src/pcf/<ControlName>/ (versioned in git). */
export const PCF_DIR = resolve(ROOT_DIR, "src", "pcf");

export interface PcfProject {
  name: string;
  dir: string;
  manifestPath: string;
  namespace: string;
  constructor: string;
  version: string;
  controlType: string;
  properties: { name: string; usage: string; ofType: string; required: boolean }[];
}

function findManifest(dir: string, depth = 0): string | undefined {
  if (depth > 3) return undefined;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", "out", "bin", "obj", "solution", "generated"].includes(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isFile() && entry.name === "ControlManifest.Input.xml") return full;
    if (entry.isDirectory()) {
      const found = findManifest(full, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

export function readManifest(manifestPath: string) {
  const doc = parseXml(readFileSync(manifestPath, "utf8"));
  const control = doc.getElementsByTagName("control")[0];
  if (!control) throw new Error(`${manifestPath} has no <control> element.`);
  return {
    namespace: control.getAttribute("namespace") ?? "",
    constructor: control.getAttribute("constructor") ?? "",
    version: control.getAttribute("version") ?? "0.0.1",
    controlType: control.getAttribute("control-type") ?? "standard",
    properties: parseProperties(doc),
  };
}

/** Properties from a control manifest (local ControlManifest.Input.xml or Dataverse customcontrol.manifest). */
export function parseProperties(doc: ReturnType<typeof parseXml>) {
  return Array.from(doc.getElementsByTagName("property")).map((p) => ({
    name: p.getAttribute("name") ?? "",
    usage: p.getAttribute("usage") ?? "input",
    ofType: p.getAttribute("of-type") ?? p.getAttribute("of-type-group") ?? "",
    required: p.getAttribute("required") === "true",
  }));
}

export function listProjects(): PcfProject[] {
  if (!existsSync(PCF_DIR)) return [];
  const projects: PcfProject[] = [];
  for (const entry of readdirSync(PCF_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(PCF_DIR, entry.name);
    const manifestPath = findManifest(dir);
    if (!manifestPath) continue;
    projects.push({ name: entry.name, dir, manifestPath, ...readManifest(manifestPath) });
  }
  return projects;
}

export function getProject(name: string): PcfProject {
  const projects = listProjects();
  const p = projects.find((x) => x.name.toLowerCase() === name.toLowerCase() || `${x.namespace}.${x.constructor}`.toLowerCase() === name.toLowerCase());
  if (!p) throw new Error(`PCF project "${name}" not found under src/pcf.${projects.length ? ` Projects: ${projects.map((x) => x.name).join(", ")}` : " Use pcf_scaffold first."}`);
  return p;
}

/** Increment the patch part of the manifest version (Dataverse only refreshes a control when its version changes). */
export function bumpVersion(manifestPath: string): { from: string; to: string } {
  const doc = parseXml(readFileSync(manifestPath, "utf8"));
  const control = doc.getElementsByTagName("control")[0]!;
  const from = control.getAttribute("version") ?? "0.0.0";
  const parts = from.split(".").map((n) => Number(n) || 0);
  while (parts.length < 3) parts.push(0);
  parts[2] += 1;
  const to = parts.join(".");
  control.setAttribute("version", to);
  writeFileSync(manifestPath, serialize(doc));
  return { from, to };
}

export function projectRoot(p: PcfProject): string {
  // The folder holding the .pcfproj is where npm scripts run.
  const pcfproj = readdirSync(p.dir).find((f) => f.endsWith(".pcfproj"));
  return pcfproj ? p.dir : dirname(dirname(p.manifestPath));
}
