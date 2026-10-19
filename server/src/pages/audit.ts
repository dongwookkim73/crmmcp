import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, relative, resolve, sep } from "node:path";
import { ROOT_DIR } from "../config.js";
import { loadYaml, TEXT_EXTENSIONS, walk, type YamlDoc } from "./site.js";

/**
 * Static security audit of a downloaded Power Pages site (enhanced or standard data model).
 * Reads table permissions, web roles, site settings, forms, lists, pages and template code.
 */

export type Severity = "critical" | "high" | "medium" | "low" | "info";
export const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];

export interface Finding {
  rule: string;
  severity: Severity;
  title: string;
  file?: string;
  line?: number;
  detail: string;
  fix: string;
}

const SCOPES: Record<number, string> = {
  756150000: "Global",
  756150001: "Contact",
  756150002: "Account",
  756150003: "Parent",
  756150004: "Self",
};
const GLOBAL = 756150000;
const PARENT = 756150003;

const FORM_MODES: Record<number, string> = { 100000000: "Insert", 100000001: "Edit", 100000002: "ReadOnly" };

export const DEFAULT_SENSITIVE_TABLES = [
  "contact", "account", "systemuser", "incident", "opportunity", "lead", "quote", "salesorder", "invoice",
  "annotation", "activitypointer", "email", "phonecall", "task", "msdyn_workorder", "bookableresourcebooking",
];

const truthy = (v: unknown) => v === true || v === "true" || v === "True" || v === 1 || v === "1";
const str = (v: unknown) => (v === undefined || v === null ? "" : String(v));
const ids = (v: unknown): string[] =>
  (Array.isArray(v) ? v : v ? [v] : []).map((x: any) => str(typeof x === "object" ? (x.id ?? x.webroleid ?? x.name) : x).toLowerCase().replace(/[{}]/g, ""));

interface Model {
  roles: { id: string; name: string; anonymous: boolean; authenticated: boolean; rel: string }[];
  permissions: {
    name: string; table: string; scope: number; read: boolean; write: boolean; create: boolean; delete: boolean;
    append: boolean; appendto: boolean; roles: string[]; parent: string; rel: string;
  }[];
  settings: Map<string, { value: string; rel: string }>;
  forms: { name: string; table: string; mode: number; permissionsEnabled: boolean; anonymous: boolean; rel: string }[];
  lists: { name: string; table: string; permissionsEnabled: boolean; rel: string }[];
  pages: { id: string; name: string; url: string; rel: string }[];
  accessRuleTargets: Set<string>;
}

function isKind(doc: YamlDoc, folder: string, suffix: string): boolean {
  return doc.rel.startsWith(`${folder}/`) || doc.rel.toLowerCase().endsWith(`.${suffix}.yml`);
}

function buildModel(docs: YamlDoc[]): Model {
  const model: Model = { roles: [], permissions: [], settings: new Map(), forms: [], lists: [], pages: [], accessRuleTargets: new Set() };
  for (const doc of docs) {
    const d = doc.data;
    if (!d || typeof d !== "object") continue;

    if (isKind(doc, "web-roles", "webrole")) {
      model.roles.push({
        id: str(d.id ?? d.webroleid).toLowerCase().replace(/[{}]/g, ""),
        name: str(d.name),
        anonymous: truthy(d.anonymoususersrole),
        authenticated: truthy(d.authenticatedusersrole),
        rel: doc.rel,
      });
    } else if (isKind(doc, "table-permissions", "tablepermission")) {
      model.permissions.push({
        name: str(d.entityname ?? d.name),
        table: str(d.entitylogicalname).toLowerCase(),
        scope: Number(d.scope),
        read: truthy(d.read),
        write: truthy(d.write),
        create: truthy(d.create),
        delete: truthy(d.delete),
        append: truthy(d.append),
        appendto: truthy(d.appendto),
        roles: ids(d.entitypermission_webrole ?? d.webroles),
        parent: str(d.parententitypermission),
        rel: doc.rel,
      });
    } else if (isKind(doc, "site-settings", "sitesetting") || basename(doc.rel).toLowerCase() === "sitesetting.yml") {
      for (const s of Array.isArray(d) ? d : [d]) {
        if (s?.name) model.settings.set(str(s.name).toLowerCase(), { value: str(s.value), rel: doc.rel });
      }
    } else if (isKind(doc, "basic-forms", "basicform") && (d.entityname || d.mode !== undefined)) {
      model.forms.push({
        name: str(d.name),
        table: str(d.entityname).toLowerCase(),
        mode: Number(d.mode),
        permissionsEnabled: truthy(d.entitypermissionsenabled),
        anonymous: false,
        rel: doc.rel,
      });
    } else if (isKind(doc, "lists", "list") && d.entityname) {
      model.lists.push({ name: str(d.name), table: str(d.entityname).toLowerCase(), permissionsEnabled: truthy(d.entitypermissionsenabled), rel: doc.rel });
    } else if (isKind(doc, "web-pages", "webpage") && d.partialurl !== undefined && !doc.rel.includes("content-pages")) {
      model.pages.push({ id: str(d.id ?? d.webpageid).toLowerCase().replace(/[{}]/g, ""), name: str(d.name), url: str(d.partialurl), rel: doc.rel });
    } else if (isKind(doc, "web-page-access-control-rules", "webpageaccesscontrolrule")) {
      model.accessRuleTargets.add(str(d.webpageid).toLowerCase().replace(/[{}]/g, ""));
    }
  }
  return model;
}

// ---------------------------------------------------------------- rules

function permissionRules(m: Model, sensitive: Set<string>, findings: Finding[]): void {
  const anonIds = new Set(m.roles.filter((r) => r.anonymous).map((r) => r.id));
  const authIds = new Set(m.roles.filter((r) => r.authenticated).map((r) => r.id));
  const roleNames = new Map(m.roles.map((r) => [r.id, r.name.toLowerCase()]));
  const isAnon = (id: string) => anonIds.has(id) || roleNames.get(id)?.includes("anonymous") || id.includes("anonymous");
  const isAuth = (id: string) => authIds.has(id) || roleNames.get(id)?.includes("authenticated") || id.includes("authenticated");
  const openRegistration = truthy(m.settings.get("authentication/registration/openregistrationenabled")?.value);

  for (const p of m.permissions) {
    const scope = SCOPES[p.scope] ?? String(p.scope);
    const privileges = (["read", "create", "write", "delete", "append", "appendto"] as const).filter((k) => p[k]);
    const writes = privileges.filter((k) => k !== "read");
    const anon = p.roles.some(isAnon);
    const auth = p.roles.some(isAuth);
    const label = `"${p.name}" (${p.table}, ${scope}: ${privileges.join("/") || "none"})`;

    if (anon && writes.length) {
      findings.push({
        rule: "PP-TP-02", severity: "critical", file: p.rel,
        title: "Anonymous users can modify data",
        detail: `Table permission ${label} grants ${writes.join("/")} to the Anonymous Users web role.`,
        fix: "Remove write privileges from the anonymous role; require sign-in and use Contact/Account/Self scope.",
      });
    }
    if (anon && p.scope === GLOBAL && p.read) {
      const isSensitive = sensitive.has(p.table);
      findings.push({
        rule: "PP-TP-01", severity: isSensitive ? "critical" : "high", file: p.rel,
        title: isSensitive ? "Anonymous users can read every row of a sensitive table" : "Anonymous users can read every row (Global scope)",
        detail: `Table permission ${label} is assigned to the Anonymous Users web role with Global scope.`,
        fix: "Confirm the data is meant to be public. Otherwise restrict to authenticated roles and Contact/Account/Self scope, and limit columns via Webapi/<table>/fields.",
      });
    }
    if (auth && p.scope === GLOBAL && (p.write || p.delete)) {
      findings.push({
        rule: "PP-TP-03", severity: openRegistration ? "critical" : "high", file: p.rel,
        title: "Any signed-in user can change or delete every row",
        detail: `Table permission ${label} gives Authenticated Users ${p.write ? "write" : ""}${p.write && p.delete ? "/" : ""}${p.delete ? "delete" : ""} with Global scope${openRegistration ? ", and open registration is enabled (anyone can sign up)" : ""}.`,
        fix: "Use Contact, Account or Self scope (or a dedicated web role) so users only change their own records.",
      });
    }
    if (!p.roles.length && p.scope !== PARENT) {
      findings.push({
        rule: "PP-TP-04", severity: "medium", file: p.rel,
        title: "Table permission is not assigned to any web role",
        detail: `Table permission ${label} has no web roles, so it never applies.`,
        fix: "Assign it to the intended web role or delete it.",
      });
    }
    if (p.scope === PARENT && !p.parent) {
      findings.push({
        rule: "PP-TP-05", severity: "medium", file: p.rel,
        title: "Parent-scope permission without a parent permission",
        detail: `Table permission ${label} uses Parent scope but no parent table permission is set.`,
        fix: "Set the parent table permission and relationship, or change the scope.",
      });
    }
  }
}

function webApiRules(m: Model, sensitive: Set<string>, findings: Finding[]): void {
  const anonIds = new Set(m.roles.filter((r) => r.anonymous).map((r) => r.id));
  for (const [name, s] of m.settings) {
    const match = name.match(/^webapi\/([^/]+)\/enabled$/);
    if (!match || !truthy(s.value)) continue;
    const table = match[1];
    const fields = m.settings.get(`webapi/${table}/fields`);
    if (!fields || fields.value.trim() === "*") {
      findings.push({
        rule: "PP-API-02", severity: sensitive.has(table) ? "high" : "medium", file: (fields ?? s).rel,
        title: "Web API exposes all columns",
        detail: `Webapi/${table} is enabled with fields ${fields ? '"*"' : "not set"}.`,
        fix: `Set Webapi/${table}/fields to the explicit comma-separated list of columns the site needs.`,
      });
    }
    const anonRead = m.permissions.find((p) => p.table === table && p.read && p.roles.some((r) => anonIds.has(r) || r.includes("anonymous")));
    if (anonRead) {
      findings.push({
        rule: "PP-API-01", severity: "critical", file: s.rel,
        title: "Web API open to anonymous users",
        detail: `Webapi/${table} is enabled and table permission "${anonRead.name}" lets anonymous users read ${table} (${SCOPES[anonRead.scope] ?? anonRead.scope} scope). Anyone can call /_api/${table} without signing in.`,
        fix: "Remove the anonymous table permission or disable the Web API for this table.",
      });
    }
  }
}

function settingRules(m: Model, findings: Finding[]): void {
  const get = (n: string) => m.settings.get(n.toLowerCase());
  const anySetting = m.settings.size > 0;

  const open = get("Authentication/Registration/OpenRegistrationEnabled");
  if (open && truthy(open.value)) {
    findings.push({
      rule: "PP-AUTH-01", severity: "medium", file: open.rel,
      title: "Open registration is enabled",
      detail: "Anyone can create an account, which turns every 'Authenticated Users' permission into a public one.",
      fix: "Disable open registration (use invitations) unless public sign-up is intended; review Authenticated Users permissions.",
    });
  }

  if (anySetting) {
    const csp = get("HTTP/Content-Security-Policy");
    if (!csp) {
      findings.push({
        rule: "PP-HDR-01", severity: "medium",
        title: "No Content-Security-Policy",
        detail: "Site setting HTTP/Content-Security-Policy is not defined.",
        fix: "Add a CSP site setting (start with default-src 'self' plus required Microsoft domains, then tighten).",
      });
    } else if (/unsafe-eval|(^|\s)\*(\s|;|$)|unsafe-inline/.test(csp.value)) {
      findings.push({
        rule: "PP-HDR-01", severity: "low", file: csp.rel,
        title: "Weak Content-Security-Policy",
        detail: `CSP contains ${["unsafe-inline", "unsafe-eval", "*"].filter((t) => csp.value.includes(t)).join(", ")}.`,
        fix: "Remove wildcards and unsafe-* where possible (use nonces for scripts).",
      });
    }
    const cors = get("HTTP/Access-Control-Allow-Origin");
    if (cors && cors.value.trim() === "*") {
      findings.push({
        rule: "PP-HDR-02", severity: "medium", file: cors.rel,
        title: "CORS allows any origin",
        detail: "HTTP/Access-Control-Allow-Origin is '*'.",
        fix: "List only the origins that need access.",
      });
    }
    if (!get("HTTP/X-Frame-Options") && !/frame-ancestors/.test(csp?.value ?? "")) {
      findings.push({
        rule: "PP-HDR-03", severity: "low",
        title: "Clickjacking protection not configured",
        detail: "Neither HTTP/X-Frame-Options nor a CSP frame-ancestors directive is set.",
        fix: "Add HTTP/X-Frame-Options = SAMEORIGIN or frame-ancestors 'self' in the CSP.",
      });
    }
  }

  for (const [name, s] of m.settings) {
    if (/(clientsecret|secret|password|apikey|api_key|connectionstring)$/i.test(name) && s.value && !/^\s*$/.test(s.value)) {
      findings.push({
        rule: "PP-SEC-02", severity: "high", file: s.rel,
        title: "Secret stored in a site setting",
        detail: `Site setting "${name}" holds a secret value in plain text (exported with the site).`,
        fix: "Move the secret to an environment variable backed by Azure Key Vault and reference it from the site setting.",
      });
    }
  }
}

function formListRules(m: Model, sensitive: Set<string>, findings: Finding[]): void {
  for (const f of m.forms) {
    if (!f.permissionsEnabled) {
      const writes = f.mode === 100000000 || f.mode === 100000001;
      findings.push({
        rule: "PP-FORM-01", severity: writes ? "high" : sensitive.has(f.table) ? "high" : "medium", file: f.rel,
        title: "Basic form does not enforce table permissions",
        detail: `Form "${f.name}" (${f.table}, ${FORM_MODES[f.mode] ?? f.mode}) has table permissions disabled.`,
        fix: "Enable table permissions on the form and grant only the needed privileges via web roles.",
      });
    }
  }
  for (const l of m.lists) {
    if (!l.permissionsEnabled) {
      findings.push({
        rule: "PP-LIST-01", severity: sensitive.has(l.table) ? "high" : "medium", file: l.rel,
        title: "List does not enforce table permissions",
        detail: `List "${l.name}" (${l.table}) has table permissions disabled; every visitor of the page sees all rows of the view.`,
        fix: "Enable table permissions on the list.",
      });
    }
  }
}

function pageRules(m: Model, findings: Finding[]): void {
  if (!m.pages.length) return;
  const internal = /(admin|manage|internal|staff|debug|test|config|setup|backoffice)/i;
  for (const p of m.pages) {
    if ((internal.test(p.name) || internal.test(p.url)) && !m.accessRuleTargets.has(p.id)) {
      findings.push({
        rule: "PP-PAGE-01", severity: "medium", file: p.rel,
        title: "Internal-looking page without page permissions",
        detail: `Page "${p.name}" (/${p.url}) has no web page access control rule.`,
        fix: "Add a page permission that restricts the page to the right web role, or remove the page if unused.",
      });
    }
  }
}

const CODE_PATTERNS: { rule: string; severity: Severity; title: string; re: RegExp; fix: string }[] = [
  {
    rule: "PP-SEC-01", severity: "high", title: "Hard-coded secret or token",
    re: /(api[_-]?key|client[_-]?secret|secret[_-]?key|password|access[_-]?token|auth[_-]?token)\s*[:=]\s*["'][^"'\s]{8,}["']|AKIA[0-9A-Z]{16}|sig=[A-Za-z0-9%]{30,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./i,
    fix: "Remove the secret from site code; call a server-side endpoint (flow, custom API) that holds it in Key Vault.",
  },
  {
    rule: "PP-LIQ-02", severity: "medium", title: "Unescaped request parameter in Liquid",
    re: /\{\{\s*request\.(params|query_string|url)[^}|]*\}\}/i,
    fix: "Pipe user input through | escape (or | h) before output.",
  },
  {
    rule: "PP-JS-01", severity: "low", title: "URL data written to innerHTML",
    re: /innerHTML\s*=\s*[^;\n]*(location|URLSearchParams|document\.URL|window\.name)/i,
    fix: "Use textContent or sanitize before inserting into the DOM.",
  },
  {
    rule: "PP-LIQ-01", severity: "info", title: "FetchXML query in Liquid",
    re: /\{%-?\s*fetchxml\b/i,
    fix: "Make sure the queried tables have matching table permissions; Liquid FetchXML respects them, so missing permissions return no rows and broad ones expose data.",
  },
];

function codeRules(root: string, findings: Finding[]): void {
  for (const file of walk(root)) {
    const dot = file.lastIndexOf(".");
    if (dot < 0 || !TEXT_EXTENSIONS.has(file.slice(dot).toLowerCase()) || /\.ya?ml$/i.test(file)) continue;
    const rel = relative(root, file).split(sep).join("/");
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    for (const pattern of CODE_PATTERNS) {
      lines.forEach((line, i) => {
        if (pattern.re.test(line)) {
          findings.push({
            rule: pattern.rule, severity: pattern.severity, title: pattern.title, file: rel, line: i + 1,
            detail: line.trim().slice(0, 160),
            fix: pattern.fix,
          });
        }
      });
    }
  }
}

// ---------------------------------------------------------------- entry points

export interface AuditResult {
  site: string;
  counts: Record<Severity, number>;
  inventory: { webRoles: number; tablePermissions: number; siteSettings: number; basicForms: number; lists: number; pages: number };
  findings: Finding[];
  warnings: string[];
}

export function auditSite(root: string, sensitiveTables: string[]): AuditResult {
  const docs = loadYaml(root);
  const model = buildModel(docs);
  const sensitive = new Set(sensitiveTables.map((t) => t.toLowerCase()));
  const findings: Finding[] = [];
  permissionRules(model, sensitive, findings);
  webApiRules(model, sensitive, findings);
  settingRules(model, findings);
  formListRules(model, sensitive, findings);
  pageRules(model, findings);
  codeRules(root, findings);
  findings.sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) || a.rule.localeCompare(b.rule));

  const warnings: string[] = [];
  const unparsed = docs.filter((d) => d.data === undefined).map((d) => d.rel);
  if (unparsed.length) warnings.push(`Could not parse ${unparsed.length} YAML file(s): ${unparsed.slice(0, 5).join(", ")}`);
  if (!model.roles.length) warnings.push("No web roles found — check the folder layout; permission rules may be incomplete.");
  if (!model.permissions.length) warnings.push("No table permissions found.");
  if (!model.settings.size) warnings.push("No site settings found — header/registration/Web API checks skipped.");

  const counts = Object.fromEntries(SEVERITY_ORDER.map((s) => [s, findings.filter((f) => f.severity === s).length])) as Record<Severity, number>;
  return {
    site: basename(root),
    counts,
    inventory: {
      webRoles: model.roles.length,
      tablePermissions: model.permissions.length,
      siteSettings: model.settings.size,
      basicForms: model.forms.length,
      lists: model.lists.length,
      pages: model.pages.length,
    },
    findings,
    warnings,
  };
}

export function writeAuditReport(result: AuditResult): string {
  const dir = resolve(ROOT_DIR, "reports");
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, `pages-security-${result.site}-${new Date().toISOString().slice(0, 10)}.md`);
  const lines = [
    `# Power Pages security audit — ${result.site}`,
    "",
    `Generated ${new Date().toISOString()}`,
    "",
    "| Severity | Count |",
    "|---|---|",
    ...SEVERITY_ORDER.map((s) => `| ${s} | ${result.counts[s]} |`),
    "",
    `Inventory: ${Object.entries(result.inventory).map(([k, v]) => `${k} ${v}`).join(", ")}`,
    "",
    ...(result.warnings.length ? ["## Warnings", "", ...result.warnings.map((w) => `- ${w}`), ""] : []),
    "## Findings",
    "",
  ];
  for (const f of result.findings) {
    lines.push(`### [${f.severity.toUpperCase()}] ${f.rule} — ${f.title}`, "");
    if (f.file) lines.push(`- File: \`${f.file}${f.line ? `:${f.line}` : ""}\``);
    lines.push(`- Detail: ${f.detail}`, `- Fix: ${f.fix}`, "");
  }
  writeFileSync(file, lines.join("\n"));
  return file;
}
