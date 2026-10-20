import { readFileSync } from "node:fs";
import { relative, sep } from "node:path";
import { walk } from "../pages/site.js";

/**
 * Quick static accessibility checks on Power Pages templates and page copy (HTML + Liquid).
 * Regex-based, so it flags likely issues for review rather than proving them; a live scan is authoritative.
 */
export interface StaticIssue {
  rule: string;
  impact: "serious" | "moderate" | "minor";
  file: string;
  line: number;
  snippet: string;
  fix: string;
}

const RULES: { rule: string; impact: StaticIssue["impact"]; re: RegExp; fix: string }[] = [
  { rule: "img-alt", impact: "serious", re: /<img\b(?![^>]*\balt\s*=)[^>]*>/i, fix: 'Add alt text (alt="" for decorative images).' },
  { rule: "link-name", impact: "serious", re: /<a\b[^>]*>\s*(<i\b[^>]*><\/i>|<span\b[^>]*class="[^"]*(glyphicon|fa-|icon)[^"]*"[^>]*><\/span>)?\s*<\/a>/i, fix: "Give the link visible text or aria-label." },
  { rule: "button-name", impact: "serious", re: /<button\b(?![^>]*aria-label)[^>]*>\s*(<(i|span)\b[^>]*><\/(i|span)>)?\s*<\/button>/i, fix: "Give the button text or aria-label." },
  { rule: "html-lang", impact: "serious", re: /<html\b(?![^>]*\blang\s*=)[^>]*>/i, fix: 'Add lang to <html>, e.g. lang="{{ website.selected_language.code }}".' },
  { rule: "tabindex-positive", impact: "moderate", re: /tabindex\s*=\s*["']?[1-9]/i, fix: "Avoid positive tabindex; use DOM order (0 or -1)." },
  { rule: "click-non-interactive", impact: "moderate", re: /<(div|span|li|td)\b(?![^>]*\brole\s*=)(?![^>]*tabindex)[^>]*\bonclick\s*=/i, fix: "Use a <button>/<a>, or add role, tabindex=0 and key handlers." },
  { rule: "input-placeholder-only", impact: "moderate", re: /<input\b(?=[^>]*placeholder)(?![^>]*(aria-label|aria-labelledby|\bid\s*=))[^>]*>/i, fix: "Associate a <label for> or aria-label; placeholder is not a label." },
  { rule: "meta-viewport-zoom", impact: "serious", re: /<meta\b[^>]*name=["']viewport["'][^>]*(user-scalable\s*=\s*no|maximum-scale\s*=\s*1(\.0)?\b)/i, fix: "Allow zoom: remove user-scalable=no / maximum-scale=1." },
  { rule: "iframe-title", impact: "serious", re: /<iframe\b(?![^>]*\btitle\s*=)[^>]*>/i, fix: "Add a title describing the frame." },
  { rule: "autoplay-media", impact: "moderate", re: /<(video|audio)\b[^>]*\bautoplay\b/i, fix: "Avoid autoplay or provide controls and muted start." },
];

export function staticA11y(root: string): StaticIssue[] {
  const issues: StaticIssue[] = [];
  for (const file of walk(root)) {
    if (!/\.(html?|liquid)$/i.test(file)) continue;
    const rel = relative(root, file).split(sep).join("/");
    const text = readFileSync(file, "utf8");
    const lines = text.split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const r of RULES) {
        const m = line.match(r.re);
        if (m) issues.push({ rule: r.rule, impact: r.impact, file: rel, line: i + 1, snippet: m[0].slice(0, 140), fix: r.fix });
      }
    });
    // Heading levels that skip (h1 -> h3) within one file.
    let last = 0;
    lines.forEach((line, i) => {
      for (const m of line.matchAll(/<h([1-6])\b/gi)) {
        const level = Number(m[1]);
        if (last && level > last + 1) {
          issues.push({ rule: "heading-order", impact: "moderate", file: rel, line: i + 1, snippet: m[0], fix: `Heading jumps from h${last} to h${level}; don't skip levels.` });
        }
        last = level;
      }
    });
  }
  return issues;
}
