/**
 * Cloud flow (Logic Apps workflow definition) helpers for solution-aware flows stored in the
 * Dataverse `workflow` table (category 5). `clientdata` holds
 * { properties: { connectionReferences, definition }, schemaVersion }.
 */

export const WORKFLOW_SCHEMA = "https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#";

export interface ClientData {
  properties: {
    connectionReferences: Record<string, ConnectionReference>;
    definition: FlowDefinition;
  };
  schemaVersion: string;
}

export interface ConnectionReference {
  runtimeSource?: string;
  connection: { connectionReferenceLogicalName: string };
  api: { name: string };
}

export interface FlowDefinition {
  $schema?: string;
  contentVersion?: string;
  parameters?: Record<string, unknown>;
  triggers: Record<string, any>;
  actions: Record<string, any>;
}

export function parseClientData(text: string | null | undefined): ClientData {
  if (!text) throw new Error("Flow has no definition (clientdata is empty).");
  const data = JSON.parse(text);
  if (!data?.properties?.definition) throw new Error("clientdata has no properties.definition.");
  data.properties.connectionReferences ??= {};
  return data;
}

/** Fill in the boilerplate a definition needs so callers can pass only triggers/actions. */
export function normalizeDefinition(def: FlowDefinition): FlowDefinition {
  return {
    $schema: def.$schema ?? WORKFLOW_SCHEMA,
    contentVersion: def.contentVersion ?? "1.0.0.0",
    parameters: {
      $connections: { defaultValue: {}, type: "Object" },
      $authentication: { defaultValue: {}, type: "SecureObject" },
      ...def.parameters,
    },
    triggers: def.triggers,
    actions: def.actions ?? {},
  };
}

export function buildClientData(def: FlowDefinition, refs: Record<string, ConnectionReference>): string {
  return JSON.stringify({ properties: { connectionReferences: refs, definition: normalizeDefinition(def) }, schemaVersion: "1.0.0.0" });
}

// ---------------------------------------------------------------- walking

interface ActionNode {
  path: string;
  name: string;
  type: string;
  runAfter: Record<string, string[]>;
  siblings: Set<string>;
  action: any;
}

/** Child action scopes of an action: If (actions/else), Switch (cases/default), Scope/Foreach/Until (actions). */
function childScopes(action: any): { label: string; actions: Record<string, any> }[] {
  const scopes: { label: string; actions: Record<string, any> }[] = [];
  if (action?.actions) scopes.push({ label: action.type === "If" ? "yes" : "do", actions: action.actions });
  if (action?.else?.actions) scopes.push({ label: "no", actions: action.else.actions });
  if (action?.cases) for (const [k, c] of Object.entries<any>(action.cases)) if (c?.actions) scopes.push({ label: `case ${k}`, actions: c.actions });
  if (action?.default?.actions) scopes.push({ label: "default", actions: action.default.actions });
  return scopes;
}

export function walkActions(actions: Record<string, any>, prefix = ""): ActionNode[] {
  const nodes: ActionNode[] = [];
  const siblings = new Set(Object.keys(actions ?? {}));
  for (const [name, action] of Object.entries(actions ?? {})) {
    const path = prefix ? `${prefix}/${name}` : name;
    nodes.push({ path, name, type: action?.type, runAfter: action?.runAfter ?? {}, siblings, action });
    for (const scope of childScopes(action)) nodes.push(...walkActions(scope.actions, `${path}[${scope.label}]`));
  }
  return nodes;
}

function describeOperation(a: any): string {
  const host = a?.inputs?.host;
  if (host?.operationId) return `${host.connectionName ?? host.apiId?.split("/").pop()}.${host.operationId}`;
  if (a?.type === "Http") return `HTTP ${a.inputs?.method ?? ""} ${String(a.inputs?.uri ?? "").slice(0, 60)}`;
  if (a?.kind) return `${a.type}/${a.kind}`;
  return a?.type ?? "?";
}

/** Indented outline of trigger and actions, ordered by runAfter where possible. */
export function outline(def: FlowDefinition): string[] {
  const lines: string[] = [];
  for (const [name, t] of Object.entries(def.triggers ?? {})) {
    const recurrence = t?.recurrence ? ` every ${t.recurrence.interval} ${t.recurrence.frequency}` : "";
    lines.push(`TRIGGER ${name}: ${describeOperation(t)}${recurrence}`);
  }
  const render = (actions: Record<string, any>, depth: number) => {
    for (const name of orderByRunAfter(actions)) {
      const a = actions[name];
      const after = Object.entries<string[]>(a?.runAfter ?? {})
        .filter(([, s]) => s.join() !== "Succeeded")
        .map(([n, s]) => `${n}:${s.join("|")}`);
      lines.push(`${"  ".repeat(depth)}- ${name}: ${describeOperation(a)}${after.length ? ` (runAfter ${after.join(", ")})` : ""}`);
      for (const scope of childScopes(a)) {
        lines.push(`${"  ".repeat(depth + 1)}[${scope.label}]`);
        render(scope.actions, depth + 2);
      }
    }
  };
  render(def.actions ?? {}, 0);
  return lines;
}

function orderByRunAfter(actions: Record<string, any>): string[] {
  const names = Object.keys(actions ?? {});
  const done = new Set<string>();
  const out: string[] = [];
  let progress = true;
  while (out.length < names.length && progress) {
    progress = false;
    for (const n of names) {
      if (done.has(n)) continue;
      const deps = Object.keys(actions[n]?.runAfter ?? {});
      if (deps.every((d) => done.has(d) || !names.includes(d))) {
        out.push(n);
        done.add(n);
        progress = true;
      }
    }
  }
  return [...out, ...names.filter((n) => !done.has(n))];
}

// ---------------------------------------------------------------- validation

const RUN_AFTER_STATUSES = new Set(["Succeeded", "Failed", "Skipped", "TimedOut"]);

export function validateDefinition(def: FlowDefinition, refs: Record<string, ConnectionReference>): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const triggers = Object.entries(def.triggers ?? {});
  if (!triggers.length) errors.push("Definition has no trigger.");
  if (triggers.length > 1) errors.push("Cloud flows support exactly one trigger.");
  if (!def.actions || typeof def.actions !== "object") errors.push("Definition has no actions object.");

  const usedConnections = new Set<string>();
  const collect = (a: any, where: string) => {
    if (!a?.type) errors.push(`${where}: missing "type".`);
    const conn = a?.inputs?.host?.connectionName;
    if (conn) usedConnections.add(conn);
    if (a?.inputs?.host && !a.inputs.host.operationId) errors.push(`${where}: connector action without inputs.host.operationId.`);
  };
  for (const [name, t] of triggers) collect(t, `trigger ${name}`);

  for (const node of walkActions(def.actions ?? {})) {
    collect(node.action, node.path);
    for (const [dep, statuses] of Object.entries(node.runAfter)) {
      if (!node.siblings.has(dep)) errors.push(`${node.path}: runAfter refers to "${dep}", which is not an action in the same scope.`);
      if (dep === node.name) errors.push(`${node.path}: runs after itself.`);
      for (const s of statuses ?? []) if (!RUN_AFTER_STATUSES.has(s)) errors.push(`${node.path}: invalid runAfter status "${s}".`);
    }
  }
  // runAfter cycles, checked per scope (actions sharing one sibling set)
  const scopes = new Map<Set<string>, ActionNode[]>();
  for (const node of walkActions(def.actions ?? {})) {
    if (!scopes.has(node.siblings)) scopes.set(node.siblings, []);
    scopes.get(node.siblings)!.push(node);
  }
  for (const nodes of scopes.values()) {
    const deps = new Map(nodes.map((n) => [n.name, Object.keys(n.runAfter)]));
    const state = new Map<string, "visiting" | "done">();
    const cyclic = (n: string): boolean => {
      if (state.get(n) === "visiting") return true;
      if (state.get(n) === "done") return false;
      state.set(n, "visiting");
      const hit = (deps.get(n) ?? []).some(cyclic);
      state.set(n, "done");
      return hit;
    };
    const start = nodes.find((n) => cyclic(n.name));
    if (start) errors.push(`${start.path}: runAfter forms a cycle.`);
  }

  for (const conn of usedConnections) {
    if (!refs[conn]) errors.push(`Actions use connection "${conn}" but connectionReferences has no "${conn}" entry.`);
  }
  for (const [key, ref] of Object.entries(refs)) {
    if (!ref?.connection?.connectionReferenceLogicalName) errors.push(`connectionReferences.${key} has no connection.connectionReferenceLogicalName (solution flows must use connection references).`);
    if (!usedConnections.has(key)) warnings.push(`connectionReferences.${key} is not used by any action.`);
  }
  const hasErrorHandling = walkActions(def.actions ?? {}).some((n) => Object.values(n.runAfter).some((s) => s.includes("Failed")));
  if (!hasErrorHandling && walkActions(def.actions ?? {}).length > 3) warnings.push("No action runs after a failure — consider a Scope + runAfter Failed error handler.");
  return { errors, warnings };
}

// ---------------------------------------------------------------- diff

function flatten(def: FlowDefinition): Map<string, string> {
  const map = new Map<string, string>();
  for (const [name, t] of Object.entries(def.triggers ?? {})) map.set(`trigger:${name}`, JSON.stringify(t));
  for (const node of walkActions(def.actions ?? {})) {
    // Compare an action without its nested children so a change deep inside a scope isn't reported on the parent.
    const { actions, else: elseBranch, cases, default: def2, ...own } = node.action ?? {};
    void actions; void elseBranch; void cases; void def2;
    map.set(node.path, JSON.stringify(own));
  }
  return map;
}

export function diffDefinitions(before: FlowDefinition, after: FlowDefinition) {
  const a = flatten(before);
  const b = flatten(after);
  return {
    added: [...b.keys()].filter((k) => !a.has(k)),
    removed: [...a.keys()].filter((k) => !b.has(k)),
    changed: [...b.keys()].filter((k) => a.has(k) && a.get(k) !== b.get(k)),
  };
}
