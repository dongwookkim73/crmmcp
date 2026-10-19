import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT_DIR } from "./config.js";

/** stdout carries the MCP protocol, so diagnostics must go to stderr. */
export function log(...args: unknown[]): void {
  console.error("[crmmcp]", ...args);
}

const LOG_DIR = resolve(ROOT_DIR, "logs");

/** Append one line to logs/audit-YYYYMMDD.jsonl. Never include record payloads. */
export function audit(entry: Record<string, unknown>): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    const day = new Date().toISOString().slice(0, 10).replaceAll("-", "");
    const line = JSON.stringify({ time: new Date().toISOString(), ...entry });
    appendFileSync(resolve(LOG_DIR, `audit-${day}.jsonl`), line + "\n");
  } catch (err) {
    log("audit write failed:", err);
  }
}
