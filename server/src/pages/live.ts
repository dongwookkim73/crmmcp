import type { Finding } from "./audit.js";

/**
 * Live, read-only checks against a deployed Power Pages site the user owns: response headers,
 * cookie flags, site visibility, and anonymous GETs to Web API endpoints. No sign-in, no writes.
 */

const TIMEOUT = 20_000;

async function get(url: string) {
  return fetch(url, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT), headers: { "User-Agent": "crmmcp-security-check" } });
}

export interface LiveResult {
  url: string;
  status: number;
  visibility: "public" | "private (redirects to sign-in)" | "unknown";
  headers: Record<string, string | null>;
  webApiProbes: { table: string; entitySet: string; status: number; exposedRows: boolean }[];
  findings: Finding[];
}

export async function liveCheck(siteUrl: string, probes: { table: string; entitySet: string }[]): Promise<LiveResult> {
  const base = siteUrl.replace(/\/+$/, "");
  // https only, except a local dev server
  if (!/^https:\/\//i.test(base) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(base)) {
    throw new Error("Site URL must start with https://");
  }
  const findings: Finding[] = [];

  const home = await get(base + "/");
  const location = home.headers.get("location") ?? "";
  const visibility = home.status >= 300 && home.status < 400 && /login\.microsoftonline|\/SignIn|\/Account\/Login/i.test(location)
    ? "private (redirects to sign-in)"
    : home.status === 200 ? "public" : "unknown";

  const names = ["content-security-policy", "strict-transport-security", "x-frame-options", "x-content-type-options", "referrer-policy", "access-control-allow-origin", "server", "x-powered-by"];
  const headers = Object.fromEntries(names.map((n) => [n, home.headers.get(n)]));
  const csp = headers["content-security-policy"];

  if (!csp) findings.push({ rule: "LIVE-HDR-CSP", severity: "medium", title: "No Content-Security-Policy header", detail: `${base}/ returned no CSP header.`, fix: "Add the HTTP/Content-Security-Policy site setting." });
  if (!headers["strict-transport-security"]) findings.push({ rule: "LIVE-HDR-HSTS", severity: "low", title: "No HSTS header", detail: "Strict-Transport-Security is missing.", fix: "Add HTTP/Strict-Transport-Security (max-age=31536000; includeSubDomains)." });
  if (!headers["x-frame-options"] && !/frame-ancestors/.test(csp ?? "")) findings.push({ rule: "LIVE-HDR-FRAME", severity: "low", title: "Page can be framed", detail: "Neither X-Frame-Options nor CSP frame-ancestors is sent.", fix: "Add HTTP/X-Frame-Options = SAMEORIGIN." });
  if (!headers["x-content-type-options"]) findings.push({ rule: "LIVE-HDR-NOSNIFF", severity: "low", title: "No X-Content-Type-Options", detail: "nosniff is not sent.", fix: "Add HTTP/X-Content-Type-Options = nosniff." });
  if (headers["access-control-allow-origin"] === "*") findings.push({ rule: "LIVE-HDR-CORS", severity: "medium", title: "CORS allows any origin", detail: "Access-Control-Allow-Origin: *", fix: "Restrict HTTP/Access-Control-Allow-Origin." });

  const cookies = home.headers.getSetCookie?.() ?? [];
  for (const c of cookies) {
    const name = c.split("=")[0];
    const missing = [!/;\s*secure/i.test(c) && "Secure", !/;\s*httponly/i.test(c) && /session|auth|antiforgery|ARRAffinity/i.test(name) && "HttpOnly", !/;\s*samesite/i.test(c) && "SameSite"].filter(Boolean);
    if (missing.length) findings.push({ rule: "LIVE-COOKIE", severity: "low", title: `Cookie ${name} lacks ${missing.join("/")}`, detail: c.split(";").slice(1).join(";").trim().slice(0, 120), fix: "Usually platform-managed; review custom cookies set by site code." });
  }

  const about = await get(base + "/_services/about");
  if (about.status === 200 && /version/i.test(await about.text())) {
    findings.push({ rule: "LIVE-ABOUT", severity: "low", title: "/_services/about is publicly readable", detail: "The about page exposes platform version details to anonymous users.", fix: "Normally restricted to admins; check that no anonymous web role grants it." });
  }

  const webApiProbes: LiveResult["webApiProbes"] = [];
  for (const p of probes) {
    const res = await get(`${base}/_api/${p.entitySet}?$top=1`);
    let exposedRows = false;
    if (res.status === 200) {
      try {
        const body = await res.json();
        exposedRows = Array.isArray(body?.value) && body.value.length > 0;
      } catch {
        // not JSON
      }
    }
    webApiProbes.push({ table: p.table, entitySet: p.entitySet, status: res.status, exposedRows });
    if (exposedRows) {
      findings.push({
        rule: "LIVE-API-ANON", severity: "critical",
        title: `Web API returns ${p.table} rows to anonymous users`,
        detail: `GET ${base}/_api/${p.entitySet}?$top=1 without signing in returned data.`,
        fix: "Remove anonymous table permissions for this table or disable Webapi/<table>/enabled.",
      });
    }
  }

  return { url: base, status: home.status, visibility, headers, webApiProbes, findings };
}
