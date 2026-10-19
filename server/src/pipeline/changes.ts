import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT_DIR } from "../config.js";
import { audit } from "../log.js";

/**
 * Two-step writes: a *_plan tool validates, snapshots the current state and registers a
 * pending change; only change_apply (with the returned token) executes it.
 */
export interface PendingChange {
  token: string;
  tool: string;
  env: string;
  solution?: string;
  summary: string;
  /** Human-readable before/after or request preview shown to the user. */
  preview: unknown;
  execute: () => Promise<unknown>;
  createdAt: number;
}

const TTL_MS = 10 * 60 * 1000;
const pending = new Map<string, PendingChange>();

function prune(): void {
  const now = Date.now();
  for (const [token, change] of pending) {
    if (now - change.createdAt > TTL_MS) pending.delete(token);
  }
}

export function registerChange(change: Omit<PendingChange, "token" | "createdAt">) {
  prune();
  const token = randomUUID().slice(0, 8);
  pending.set(token, { ...change, token, createdAt: Date.now() });
  audit({ event: "plan", token, tool: change.tool, env: change.env, solution: change.solution, summary: change.summary });
  return {
    changeToken: token,
    expiresInMinutes: TTL_MS / 60000,
    summary: change.summary,
    preview: change.preview,
    next: `Review the preview with the user, then call change_apply with changeToken "${token}".`,
  };
}

export async function applyChange(token: string) {
  prune();
  const change = pending.get(token);
  if (!change) throw new Error(`No pending change "${token}" (expired after 10 minutes or already applied).`);
  pending.delete(token);
  const started = Date.now();
  try {
    const result = await change.execute();
    audit({ event: "apply", token, tool: change.tool, env: change.env, solution: change.solution, ok: true, ms: Date.now() - started });
    return { applied: change.summary, result };
  } catch (err) {
    audit({ event: "apply", token, tool: change.tool, env: change.env, ok: false, error: (err as Error).message });
    throw err;
  }
}

export function discardChange(token: string): boolean {
  return pending.delete(token);
}

export function listChanges() {
  prune();
  return [...pending.values()].map(({ token, tool, env, solution, summary, createdAt }) => ({
    token,
    tool,
    env,
    solution,
    summary,
    ageSeconds: Math.round((Date.now() - createdAt) / 1000),
  }));
}

/** Save the pre-change state of a component under backups/<date>/<env>/ for rollback and git history. */
export function saveSnapshot(env: string, component: string, id: string, content: unknown): string {
  const day = new Date().toISOString().slice(0, 10);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = resolve(ROOT_DIR, "backups", day, env);
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, `${component}-${id}-${stamp}.json`);
  writeFileSync(file, JSON.stringify(content, null, 2));
  return file;
}
