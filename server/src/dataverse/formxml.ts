import { randomUUID } from "node:crypto";
import { DOMParser, XMLSerializer, type Document, type Element, type Node } from "@xmldom/xmldom";

/**
 * FormXML helpers. Forms are edited through small named operations instead of having the model
 * rewrite the whole XML, so a mistake can only touch the element an operation names.
 */

export const guid = () => `{${randomUUID()}}`;

/** Control class IDs for standard field controls, keyed by AttributeType (and String format). */
const CLASS_IDS: Record<string, string> = {
  String: "{4273EDBD-AC1D-40d3-9FB2-095C621B552D}",
  "String:Email": "{ADA2203E-B4CD-49be-9DDF-234642B43B52}",
  "String:Url": "{71716B6C-711E-476c-8AB8-5D11542BFB47}",
  "String:Phone": "{8C10015A-B339-4982-9474-A95FE05631A5}",
  "String:TickerSymbol": "{1E1FC551-F7A8-43af-AC34-A8DC35C7B6D4}",
  "String:TextArea": "{E0DECE4B-6FC8-4a8f-A065-082708572369}",
  Memo: "{E0DECE4B-6FC8-4a8f-A065-082708572369}",
  Integer: "{C6D124CA-7EDA-4a60-AEA9-7FB8D318B68F}",
  BigInt: "{C6D124CA-7EDA-4a60-AEA9-7FB8D318B68F}",
  Decimal: "{C3EFE0C3-0EC6-42be-8349-CBD9079DFD8E}",
  Double: "{0D2C745A-E5A8-4c8f-BA63-C6D3BB604660}",
  Money: "{533B9E00-756B-4312-95A0-DC888637AC78}",
  DateTime: "{5B773807-9FB2-42db-97C3-7A91EFF8ADFF}",
  Boolean: "{67FAC785-CD58-4f9f-ABB3-4B7DDC6ED5ED}",
  Picklist: "{3EF39988-22BB-4f0b-BBBE-64B5A3748AEE}",
  State: "{3EF39988-22BB-4f0b-BBBE-64B5A3748AEE}",
  Status: "{5D68B988-0661-4db2-BC3E-17598AD3BE6C}",
  Virtual: "{4AA28AB7-9C13-4F57-A73D-AD894D048B5F}", // multi-select choice
  Lookup: "{270BD3DB-D9AF-4782-9025-509E298DEC0A}",
  Customer: "{270BD3DB-D9AF-4782-9025-509E298DEC0A}",
  Owner: "{270BD3DB-D9AF-4782-9025-509E298DEC0A}",
};
export const SUBGRID_CLASS_ID = "{E7A81278-8635-4d9e-8D4D-59480B391C5B}";

export interface FieldInfo {
  type: string;
  format?: string;
  displayName?: string;
}

export function classIdFor(field: string, info: FieldInfo | undefined): string {
  if (!info) throw new Error(`Column "${field}" does not exist on this table.`);
  const id = CLASS_IDS[`${info.type}:${info.format}`] ?? CLASS_IDS[info.type];
  if (!id) throw new Error(`No standard form control known for column "${field}" (type ${info.type}). Add it in the form designer.`);
  return id;
}

export function parseXml(xml: string): Document {
  const errors: string[] = [];
  const doc = new DOMParser({ onError: (level, msg) => level !== "warning" && errors.push(msg) }).parseFromString(xml, "text/xml");
  if (errors.length) throw new Error(`Invalid XML: ${errors[0]}`);
  return doc;
}

export function serialize(doc: Node): string {
  return new XMLSerializer().serializeToString(doc);
}

export function children(el: Element, tag: string): Element[] {
  const out: Element[] = [];
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && (n as Element).tagName === tag) out.push(n as Element);
  }
  return out;
}

function child(el: Element, tag: string, create = false): Element | undefined {
  const found = children(el, tag)[0];
  if (found || !create) return found;
  const made = el.ownerDocument!.createElement(tag);
  el.appendChild(made);
  return made;
}

function all(el: Document | Element, tag: string): Element[] {
  return Array.from(el.getElementsByTagName(tag)) as Element[];
}

function labelOf(el: Element): string | undefined {
  const labels = child(el, "labels");
  const l = labels && children(labels, "label")[0];
  return l?.getAttribute("description") ?? undefined;
}

function setLabel(el: Element, text: string, lang: number): void {
  const doc = el.ownerDocument!;
  let labels = child(el, "labels");
  if (!labels) {
    labels = doc.createElement("labels");
    el.insertBefore(labels, el.firstChild);
  }
  let l = children(labels, "label").find((x) => x.getAttribute("languagecode") === String(lang));
  if (!l) {
    l = doc.createElement("label");
    l.setAttribute("languagecode", String(lang));
    labels.appendChild(l);
  }
  l.setAttribute("description", text);
}

function makeLabels(doc: Document, text: string, lang: number): Element {
  const labels = doc.createElement("labels");
  const l = doc.createElement("label");
  l.setAttribute("description", text);
  l.setAttribute("languagecode", String(lang));
  labels.appendChild(l);
  return labels;
}

/** Match a tab/section by name attribute or (case-insensitive) label. */
function matches(el: Element, key: string): boolean {
  return el.getAttribute("name") === key || labelOf(el)?.toLowerCase() === key.toLowerCase();
}

function findTab(doc: Document, key: string): Element {
  const tab = all(doc, "tab").find((t) => matches(t, key));
  if (!tab) throw new Error(`Tab "${key}" not found. Tabs: ${all(doc, "tab").map((t) => labelOf(t) ?? t.getAttribute("name")).join(", ")}`);
  return tab;
}

function findSection(doc: Document, key: string, tabKey?: string): Element {
  const scope: Document | Element = tabKey ? findTab(doc, tabKey) : doc;
  const hits = all(scope, "section").filter((s) => matches(s, key));
  if (!hits.length) {
    throw new Error(`Section "${key}" not found. Sections: ${all(scope, "section").map((s) => labelOf(s) ?? s.getAttribute("name")).join(", ")}`);
  }
  if (hits.length > 1) throw new Error(`Section "${key}" is ambiguous; pass tab as well.`);
  return hits[0];
}

/** Controls bound to a column (body + header). */
function fieldControls(doc: Document, field: string): Element[] {
  return all(doc, "control").filter((c) => c.getAttribute("datafieldname") === field);
}

function fieldCell(doc: Document, field: string): Element {
  const controls = fieldControls(doc, field).filter((c) => !isInHeader(c));
  if (!controls.length) throw new Error(`Field "${field}" is not on the form body.`);
  return controls[0].parentNode as Element;
}

function isInHeader(el: Element): boolean {
  for (let n = el.parentNode; n; n = n.parentNode) {
    if ((n as Element).tagName === "header") return true;
  }
  return false;
}

function makeFieldCell(doc: Document, field: string, info: FieldInfo | undefined, lang: number, opts: { label?: string; disabled?: boolean }): Element {
  const cell = doc.createElement("cell");
  cell.setAttribute("id", guid());
  cell.setAttribute("showlabel", "true");
  cell.appendChild(makeLabels(doc, opts.label ?? info?.displayName ?? field, lang));
  const control = doc.createElement("control");
  control.setAttribute("id", uniqueControlId(doc, field));
  control.setAttribute("classid", classIdFor(field, info));
  control.setAttribute("datafieldname", field);
  control.setAttribute("disabled", String(opts.disabled ?? false));
  cell.appendChild(control);
  return cell;
}

function uniqueControlId(doc: Document, base: string): string {
  const ids = new Set(all(doc, "control").map((c) => c.getAttribute("id")));
  if (!ids.has(base)) return base;
  for (let i = 1; ; i++) if (!ids.has(`${base}${i}`)) return `${base}${i}`;
}

function sectionRows(section: Element): Element {
  return child(section, "rows", true)!;
}

function rowWith(doc: Document, cell: Element): Element {
  const row = doc.createElement("row");
  row.appendChild(cell);
  return row;
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export type FormOp =
  | { op: "addTab"; label: string; name?: string; after?: string; columns?: 1 | 2 | 3 }
  | { op: "addSection"; tab: string; label: string; name?: string; columns?: 1 | 2 | 3 | 4; showLabel?: boolean; column?: number }
  | { op: "addField"; field: string; section?: string; tab?: string; header?: boolean; after?: string; label?: string; disabled?: boolean }
  | { op: "removeField"; field: string; header?: boolean }
  | { op: "moveField"; field: string; section: string; tab?: string; after?: string }
  | { op: "setFieldProps"; field: string; label?: string; visible?: boolean; disabled?: boolean; showLabel?: boolean }
  | { op: "setTabProps"; tab: string; label?: string; visible?: boolean; expanded?: boolean }
  | { op: "setSectionProps"; section: string; tab?: string; label?: string; visible?: boolean; showLabel?: boolean }
  | {
      op: "addSubgrid";
      section: string;
      tab?: string;
      name: string;
      label: string;
      table: string;
      relationship?: string;
      viewId: string;
      rows?: number;
    }
  | { op: "addLibrary"; library: string }
  | {
      op: "addEventHandler";
      event: "onload" | "onsave" | "onchange";
      field?: string;
      library: string;
      functionName: string;
      passContext?: boolean;
      parameters?: string;
    }
  | { op: "removeEventHandler"; event: "onload" | "onsave" | "onchange"; field?: string; functionName: string };

export interface PatchContext {
  lang: number;
  fields: Map<string, FieldInfo>;
  webResourceExists: (name: string) => Promise<boolean>;
}

export async function applyOps(xml: string, ops: FormOp[], pc: PatchContext): Promise<{ xml: string; log: string[] }> {
  const doc = parseXml(xml);
  const form = doc.documentElement!;
  const log: string[] = [];

  for (const [i, op] of ops.entries()) {
    const where = `op #${i + 1} (${op.op})`;
    try {
      switch (op.op) {
        case "addTab": {
          const tabs = child(form, "tabs", true)!;
          const tab = doc.createElement("tab");
          tab.setAttribute("name", op.name ?? `tab_${randomUUID().slice(0, 8)}`);
          tab.setAttribute("id", guid());
          tab.setAttribute("expanded", "true");
          tab.setAttribute("showlabel", "true");
          tab.setAttribute("verticallayout", "true");
          tab.appendChild(makeLabels(doc, op.label, pc.lang));
          const columns = doc.createElement("columns");
          const n = op.columns ?? 1;
          for (let c = 0; c < n; c++) {
            const col = doc.createElement("column");
            col.setAttribute("width", `${Math.floor(100 / n)}%`);
            col.appendChild(doc.createElement("sections"));
            columns.appendChild(col);
          }
          tab.appendChild(columns);
          const after = op.after ? findTab(doc, op.after) : undefined;
          tabs.insertBefore(tab, after ? after.nextSibling : null);
          log.push(`added tab "${op.label}"`);
          break;
        }
        case "addSection": {
          const tab = findTab(doc, op.tab);
          const cols = children(child(tab, "columns", true)!, "column");
          const column = cols[(op.column ?? 1) - 1];
          if (!column) throw new Error(`Tab "${op.tab}" has ${cols.length} column(s).`);
          const section = doc.createElement("section");
          section.setAttribute("name", op.name ?? `section_${randomUUID().slice(0, 8)}`);
          section.setAttribute("id", guid());
          section.setAttribute("showlabel", String(op.showLabel ?? true));
          section.setAttribute("showbar", "false");
          section.setAttribute("columns", "1".repeat(op.columns ?? 1));
          section.appendChild(makeLabels(doc, op.label, pc.lang));
          section.appendChild(doc.createElement("rows"));
          child(column, "sections", true)!.appendChild(section);
          log.push(`added section "${op.label}" to tab "${op.tab}"`);
          break;
        }
        case "addField": {
          if (op.header) {
            if (fieldControls(doc, op.field).some(isInHeader)) throw new Error(`"${op.field}" is already in the header.`);
            const header = child(form, "header", true)!;
            if (!header.getAttribute("id")) header.setAttribute("id", guid());
            const rows = child(header, "rows", true)!;
            let row = children(rows, "row")[0];
            if (!row) rows.appendChild((row = doc.createElement("row")));
            row.appendChild(makeFieldCell(doc, op.field, pc.fields.get(op.field), pc.lang, op));
            log.push(`added "${op.field}" to header`);
            break;
          }
          if (!op.section) throw new Error("addField needs section (or header: true).");
          if (fieldControls(doc, op.field).some((c) => !isInHeader(c))) {
            throw new Error(`"${op.field}" is already on the form. Use moveField.`);
          }
          const section = findSection(doc, op.section, op.tab);
          const row = rowWith(doc, makeFieldCell(doc, op.field, pc.fields.get(op.field), pc.lang, op));
          insertRow(doc, section, row, op.after);
          log.push(`added "${op.field}" to section "${op.section}"`);
          break;
        }
        case "removeField": {
          const controls = fieldControls(doc, op.field).filter((c) => Boolean(op.header) === isInHeader(c));
          if (!controls.length) throw new Error(`"${op.field}" is not on the form${op.header ? " header" : ""}.`);
          for (const control of controls) removeCell(control.parentNode as Element);
          removeFieldEvents(doc, op.field, Boolean(op.header));
          log.push(`removed "${op.field}"${op.header ? " from header" : ""}`);
          break;
        }
        case "moveField": {
          const cell = fieldCell(doc, op.field);
          const section = findSection(doc, op.section, op.tab);
          removeCell(cell);
          insertRow(doc, section, rowWith(doc, cell), op.after);
          log.push(`moved "${op.field}" to section "${op.section}"`);
          break;
        }
        case "setFieldProps": {
          const cell = fieldCell(doc, op.field);
          const control = children(cell, "control")[0];
          if (op.label !== undefined) setLabel(cell, op.label, pc.lang);
          if (op.visible !== undefined) cell.setAttribute("visible", String(op.visible));
          if (op.showLabel !== undefined) cell.setAttribute("showlabel", String(op.showLabel));
          if (op.disabled !== undefined) control.setAttribute("disabled", String(op.disabled));
          log.push(`updated field "${op.field}"`);
          break;
        }
        case "setTabProps": {
          const tab = findTab(doc, op.tab);
          if (op.label !== undefined) setLabel(tab, op.label, pc.lang);
          if (op.visible !== undefined) tab.setAttribute("visible", String(op.visible));
          if (op.expanded !== undefined) tab.setAttribute("expanded", String(op.expanded));
          log.push(`updated tab "${op.tab}"`);
          break;
        }
        case "setSectionProps": {
          const section = findSection(doc, op.section, op.tab);
          if (op.label !== undefined) setLabel(section, op.label, pc.lang);
          if (op.visible !== undefined) section.setAttribute("visible", String(op.visible));
          if (op.showLabel !== undefined) section.setAttribute("showlabel", String(op.showLabel));
          log.push(`updated section "${op.section}"`);
          break;
        }
        case "addSubgrid": {
          const section = findSection(doc, op.section, op.tab);
          const cell = doc.createElement("cell");
          cell.setAttribute("id", guid());
          cell.setAttribute("showlabel", "true");
          cell.setAttribute("rowspan", String(op.rows ?? 4));
          cell.setAttribute("colspan", "1");
          cell.appendChild(makeLabels(doc, op.label, pc.lang));
          const control = doc.createElement("control");
          control.setAttribute("id", uniqueControlId(doc, op.name));
          control.setAttribute("classid", SUBGRID_CLASS_ID);
          control.setAttribute("indicationOfSubgrid", "true");
          control.setAttribute("uniqueid", guid());
          const params = doc.createElement("parameters");
          const p = (tag: string, value: string) => {
            const e = doc.createElement(tag);
            if (value) e.appendChild(doc.createTextNode(value));
            params.appendChild(e);
          };
          p("ViewId", op.viewId.startsWith("{") ? op.viewId : `{${op.viewId}}`);
          p("IsUserView", "false");
          p("RelationshipName", op.relationship ?? "");
          p("TargetEntityType", op.table);
          p("AutoExpand", "Fixed");
          p("EnableQuickFind", "false");
          p("EnableViewPicker", "false");
          p("EnableJumpBar", "false");
          p("ChartGridMode", "Grid");
          p("VisualizationId", "");
          p("IsUserChart", "false");
          p("EnableChartPicker", "false");
          p("RecordsPerPage", String(op.rows ?? 4));
          control.appendChild(params);
          cell.appendChild(control);
          const rows = sectionRows(section);
          rows.appendChild(rowWith(doc, cell));
          for (let r = 1; r < (op.rows ?? 4); r++) rows.appendChild(doc.createElement("row"));
          log.push(`added subgrid "${op.label}" (${op.table})`);
          break;
        }
        case "addLibrary": {
          if (!(await pc.webResourceExists(op.library))) throw new Error(`Web resource "${op.library}" not found.`);
          ensureLibrary(doc, op.library);
          log.push(`added library ${op.library}`);
          break;
        }
        case "addEventHandler": {
          if (op.event === "onchange" && !op.field) throw new Error("onchange handlers need field.");
          if (op.event === "onchange" && !pc.fields.has(op.field!)) throw new Error(`Column "${op.field}" does not exist.`);
          if (!(await pc.webResourceExists(op.library))) throw new Error(`Web resource "${op.library}" not found.`);
          ensureLibrary(doc, op.library);
          const handlers = eventHandlers(doc, op.event, op.field, true)!;
          if (children(handlers, "Handler").some((h) => h.getAttribute("functionName") === op.functionName && h.getAttribute("libraryName") === op.library)) {
            throw new Error(`${op.functionName} is already registered on ${op.event}${op.field ? ` of ${op.field}` : ""}.`);
          }
          const h = doc.createElement("Handler");
          h.setAttribute("functionName", op.functionName);
          h.setAttribute("libraryName", op.library);
          h.setAttribute("handlerUniqueId", guid());
          h.setAttribute("enabled", "true");
          h.setAttribute("parameters", op.parameters ?? "");
          h.setAttribute("passExecutionContext", String(op.passContext ?? true));
          handlers.appendChild(h);
          log.push(`registered ${op.functionName} on ${op.event}${op.field ? ` of ${op.field}` : ""}`);
          break;
        }
        case "removeEventHandler": {
          const handlers = eventHandlers(doc, op.event, op.field, false);
          const h = handlers && children(handlers, "Handler").find((x) => x.getAttribute("functionName") === op.functionName);
          if (!h) throw new Error(`${op.functionName} is not registered on ${op.event}${op.field ? ` of ${op.field}` : ""}.`);
          handlers!.removeChild(h);
          log.push(`removed ${op.functionName} from ${op.event}`);
          break;
        }
      }
    } catch (err) {
      throw new Error(`${where}: ${(err as Error).message}`);
    }
  }
  return { xml: serialize(doc), log };
}

function insertRow(doc: Document, section: Element, row: Element, after?: string): void {
  const rows = sectionRows(section);
  if (after) {
    const anchorRow = fieldControls(doc, after)
      .map((c) => c.parentNode?.parentNode as Element | undefined)
      .find((r) => r?.parentNode === rows);
    if (!anchorRow) throw new Error(`"${after}" is not in this section.`);
    rows.insertBefore(row, anchorRow.nextSibling);
  } else {
    rows.appendChild(row);
  }
}

/** Remove a cell; drop its row when it becomes empty. */
function removeCell(cell: Element): void {
  const row = cell.parentNode as Element;
  row.removeChild(cell);
  if (!children(row, "cell").length) row.parentNode?.removeChild(row);
}

function removeFieldEvents(doc: Document, field: string, header: boolean): void {
  if (header) return;
  const events = child(doc.documentElement!, "events");
  for (const ev of events ? children(events, "event") : []) {
    if (ev.getAttribute("name") === "onchange" && ev.getAttribute("attribute") === field) events!.removeChild(ev);
  }
}

function ensureLibrary(doc: Document, name: string): void {
  const libs = child(doc.documentElement!, "formLibraries", true)!;
  if (children(libs, "Library").some((l) => l.getAttribute("name") === name)) return;
  const lib = doc.createElement("Library");
  lib.setAttribute("name", name);
  lib.setAttribute("libraryUniqueId", guid());
  libs.appendChild(lib);
}

function eventHandlers(doc: Document, name: string, field: string | undefined, create: boolean): Element | undefined {
  const form = doc.documentElement!;
  const events = child(form, "events", create);
  if (!events) return undefined;
  let ev = children(events, "event").find(
    (e) => e.getAttribute("name") === name && (name !== "onchange" || e.getAttribute("attribute") === field),
  );
  if (!ev) {
    if (!create) return undefined;
    ev = doc.createElement("event");
    ev.setAttribute("name", name);
    ev.setAttribute("application", "false");
    ev.setAttribute("active", "false");
    if (name === "onchange") ev.setAttribute("attribute", field!);
    events.appendChild(ev);
  }
  return child(ev, "Handlers", create);
}

// ---------------------------------------------------------------------------
// Summary + new forms
// ---------------------------------------------------------------------------

export function summarizeForm(xml: string) {
  const doc = parseXml(xml);
  const form = doc.documentElement!;
  const cellSummary = (cell: Element) => {
    const control = children(cell, "control")[0];
    if (!control) return undefined;
    const isSubgrid = control.getAttribute("classid")?.toUpperCase() === SUBGRID_CLASS_ID.toUpperCase();
    const flags = [
      cell.getAttribute("visible") === "false" ? "hidden" : "",
      control.getAttribute("disabled") === "true" ? "read-only" : "",
      children(control, "customControl").length || all(control, "customControl").length ? "custom-control" : "",
    ].filter(Boolean);
    return isSubgrid
      ? `[subgrid] ${labelOf(cell) ?? control.getAttribute("id")} (${all(control, "TargetEntityType")[0]?.textContent ?? "?"})`
      : `${control.getAttribute("datafieldname") ?? control.getAttribute("id")}${labelOf(cell) ? ` "${labelOf(cell)}"` : ""}${flags.length ? ` (${flags.join(", ")})` : ""}`;
  };
  const tabs = all(doc, "tab").map((tab) => ({
    tab: labelOf(tab) ?? tab.getAttribute("name"),
    name: tab.getAttribute("name"),
    ...(tab.getAttribute("visible") === "false" ? { hidden: true } : {}),
    sections: all(tab, "section").map((s) => ({
      section: labelOf(s) ?? s.getAttribute("name"),
      name: s.getAttribute("name"),
      ...(s.getAttribute("visible") === "false" ? { hidden: true } : {}),
      fields: all(s, "cell").map(cellSummary).filter(Boolean),
    })),
  }));
  const header = child(form, "header");
  const events = child(form, "events");
  return {
    header: header ? all(header, "cell").map(cellSummary).filter(Boolean) : [],
    tabs,
    libraries: (() => {
      const libs = child(form, "formLibraries");
      return libs ? children(libs, "Library").map((l) => l.getAttribute("name")) : [];
    })(),
    events: events
      ? children(events, "event").flatMap((e) => {
          const handlers = child(e, "Handlers");
          return (handlers ? children(handlers, "Handler") : []).map(
            (h) => `${e.getAttribute("name")}${e.getAttribute("attribute") ? `(${e.getAttribute("attribute")})` : ""}: ${h.getAttribute("libraryName")} → ${h.getAttribute("functionName")}`,
          );
        })
      : [],
  };
}

/** Minimal valid FormXML with one tab and one section; layout is then filled with applyOps. */
export function emptyFormXml(lang: number, tabLabel = "General", sectionLabel = "General"): string {
  return (
    `<form><tabs><tab name="general" id="${guid()}" expanded="true" showlabel="true" verticallayout="true">` +
    `<labels><label description="${escapeXml(tabLabel)}" languagecode="${lang}"/></labels>` +
    `<columns><column width="100%"><sections>` +
    `<section name="general_section" id="${guid()}" showlabel="false" showbar="false" columns="11">` +
    `<labels><label description="${escapeXml(sectionLabel)}" languagecode="${lang}"/></labels><rows/>` +
    `</section></sections></column></columns></tab></tabs></form>`
  );
}

/** Give every id-bearing element a fresh GUID so a cloned form doesn't collide with its source. */
export function regenerateIds(xml: string): string {
  const doc = parseXml(xml);
  for (const tag of ["tab", "section", "cell", "header", "footer"]) {
    for (const el of all(doc, tag)) if (el.getAttribute("id")?.startsWith("{")) el.setAttribute("id", guid());
  }
  for (const el of all(doc, "Library")) el.setAttribute("libraryUniqueId", guid());
  for (const el of all(doc, "Handler")) el.setAttribute("handlerUniqueId", guid());
  for (const el of all(doc, "control")) if (el.getAttribute("uniqueid")) el.setAttribute("uniqueid", guid());
  return serialize(doc);
}

export function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Line diff limited to changed lines, for previews. */
export function xmlDiff(before: string, after: string, max = 60): string[] {
  const pretty = (x: string) => x.replace(/></g, ">\n<").split("\n");
  const a = pretty(before);
  const b = pretty(after);
  const setA = new Set(a);
  const setB = new Set(b);
  const out = [...a.filter((l) => !setB.has(l)).map((l) => `- ${l}`), ...b.filter((l) => !setA.has(l)).map((l) => `+ ${l}`)];
  return out.length > max ? [...out.slice(0, max), `... ${out.length - max} more line(s)`] : out;
}
