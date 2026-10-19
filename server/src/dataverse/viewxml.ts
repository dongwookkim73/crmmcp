import type { Document, Element } from "@xmldom/xmldom";
import { children, escapeXml, parseXml, serialize } from "./formxml.js";

/**
 * View (savedquery) helpers. Columns may use "lookupcolumn.targetcolumn" to show a column of a
 * related table, e.g. "dwmcp_accountid.telephone1"; the needed link-entity is generated.
 */

export interface ViewColumn {
  name: string;
  width?: number;
}
export interface ViewCondition {
  column: string;
  operator: string;
  value?: string | number | boolean | (string | number)[];
}
export interface ViewOrder {
  column: string;
  descending?: boolean;
}
export interface LinkTarget {
  table: string;
  primaryId: string;
}

export interface ViewParts {
  columns?: ViewColumn[];
  orderBy?: ViewOrder[];
  filters?: ViewCondition[];
  filterType?: "and" | "or";
  /** Raw <filter>...</filter> XML, used instead of filters when given. */
  filterXml?: string;
}

export const linkAlias = (lookup: string) => `a_${lookup}`;

/** Lookup columns referenced via "lookup.column" notation. */
export function lookupsUsed(columns: ViewColumn[]): string[] {
  return [...new Set(columns.filter((c) => c.name.includes(".")).map((c) => c.name.split(".")[0]))];
}

function el(doc: Document, tag: string, attrs: Record<string, string>): Element {
  const e = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

function conditionXml(c: ViewCondition): string {
  const base = `attribute="${escapeXml(c.column)}" operator="${escapeXml(c.operator)}"`;
  if (Array.isArray(c.value)) {
    return `<condition ${base}>${c.value.map((v) => `<value>${escapeXml(String(v))}</value>`).join("")}</condition>`;
  }
  if (c.value === undefined || c.value === null) return `<condition ${base}/>`;
  return `<condition ${base} value="${escapeXml(String(c.value))}"/>`;
}

function filterNode(doc: Document, parts: ViewParts): Element | undefined {
  const xml = parts.filterXml ?? (parts.filters?.length ? `<filter type="${parts.filterType ?? "and"}">${parts.filters.map(conditionXml).join("")}</filter>` : undefined);
  if (!xml) return undefined;
  const parsed = parseXml(xml).documentElement!;
  if (parsed.tagName !== "filter") throw new Error("filterXml must be a single <filter> element.");
  return doc.importNode(parsed, true) as Element;
}

/**
 * Build or update FetchXML. With `existing`, only the parts given are replaced:
 * columns rebuild the attribute lists, orderBy replaces orders, filters/filterXml replace top-level filters.
 */
export function buildFetchXml(
  table: string,
  primaryId: string,
  parts: ViewParts,
  links: Map<string, LinkTarget>,
  existing?: string,
): string {
  const doc = parseXml(existing ?? `<fetch version="1.0" mapping="logical" output-format="xml-platform"><entity name="${table}"/></fetch>`);
  const entity = children(doc.documentElement!, "entity")[0];
  if (!entity) throw new Error("FetchXML has no <entity>.");

  if (parts.columns) {
    for (const a of children(entity, "attribute")) entity.removeChild(a);
    for (const link of children(entity, "link-entity")) {
      for (const a of children(link, "attribute")) link.removeChild(a);
      if (!link.firstChild || !Array.from(link.childNodes).some((n) => n.nodeType === 1)) entity.removeChild(link);
    }
    const firstNonAttr = Array.from(entity.childNodes).find((n) => n.nodeType === 1) ?? null;
    const own = parts.columns.filter((c) => !c.name.includes(".")).map((c) => c.name);
    for (const name of [...new Set([...own, primaryId])]) entity.insertBefore(el(doc, "attribute", { name }), firstNonAttr);

    for (const lookup of lookupsUsed(parts.columns)) {
      const target = links.get(lookup);
      if (!target) throw new Error(`"${lookup}" is not a lookup column on ${table}.`);
      const alias = linkAlias(lookup);
      let link = children(entity, "link-entity").find((l) => l.getAttribute("alias") === alias);
      if (!link) {
        link = el(doc, "link-entity", { name: target.table, from: target.primaryId, to: lookup, alias, "link-type": "outer", visible: "false" });
        entity.appendChild(link);
      }
      for (const c of parts.columns.filter((c) => c.name.startsWith(`${lookup}.`))) {
        link.appendChild(el(doc, "attribute", { name: c.name.split(".")[1] }));
      }
    }
  }

  if (parts.orderBy) {
    for (const o of children(entity, "order")) entity.removeChild(o);
    for (const o of parts.orderBy) {
      entity.appendChild(el(doc, "order", { attribute: o.column, descending: String(o.descending ?? false) }));
    }
  }

  const filter = filterNode(doc, parts);
  if (filter) {
    for (const f of children(entity, "filter")) entity.removeChild(f);
    entity.appendChild(filter);
  }
  return serialize(doc);
}

/** LayoutXML: the grid columns shown in the view. Link columns use "alias.column". */
export function buildLayoutXml(objectTypeCode: number, primaryId: string, primaryName: string, columns: ViewColumn[], existing?: string): string {
  const doc = parseXml(
    existing ??
      `<grid name="resultset" object="${objectTypeCode}" jump="${primaryName}" select="1" icon="1" preview="1"><row name="result" id="${primaryId}"/></grid>`,
  );
  const row = children(doc.documentElement!, "row")[0];
  for (const c of children(row, "cell")) row.removeChild(c);
  for (const c of columns) {
    const name = c.name.includes(".") ? `${linkAlias(c.name.split(".")[0])}.${c.name.split(".")[1]}` : c.name;
    row.appendChild(el(doc, "cell", { name, width: String(c.width ?? 150) }));
  }
  return serialize(doc);
}

export function summarizeView(fetchXml: string, layoutXml: string) {
  const fetch = parseXml(fetchXml);
  const entity = children(fetch.documentElement!, "entity")[0];
  const aliasToLookup = new Map(children(entity, "link-entity").map((l) => [l.getAttribute("alias") ?? "", l.getAttribute("to") ?? ""]));
  const layout = parseXml(layoutXml);
  const row = children(layout.documentElement!, "row")[0];
  return {
    columns: (row ? children(row, "cell") : []).map((c) => {
      const name = c.getAttribute("name") ?? "";
      const [alias, col] = name.split(".");
      return { name: col && aliasToLookup.has(alias) ? `${aliasToLookup.get(alias)}.${col}` : name, width: Number(c.getAttribute("width")) };
    }),
    orderBy: children(entity, "order").map((o) => ({ column: o.getAttribute("attribute"), descending: o.getAttribute("descending") === "true" })),
    filter: children(entity, "filter").map((f) => serialize(f)).join("") || null,
    links: children(entity, "link-entity").map((l) => `${l.getAttribute("to")} -> ${l.getAttribute("name")} (${l.getAttribute("alias")})`),
  };
}
