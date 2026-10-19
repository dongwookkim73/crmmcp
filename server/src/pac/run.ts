import { spawn } from "node:child_process";
import { log } from "../log.js";

export interface PacResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run the Power Platform CLI. pac uses its own auth profiles (`pac auth create`); every call passes
 * --environment explicitly where supported so the active profile's org selection doesn't matter.
 */
export function pac(args: string[], options: { cwd?: string; timeoutMs?: number } = {}): Promise<PacResult> {
  return new Promise((resolvePromise, reject) => {
    log("pac", args.join(" "));
    const child = spawn("pac", args, { cwd: options.cwd, shell: process.platform === "win32", windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`pac ${args[0]} ${args[1] ?? ""} timed out after ${(options.timeoutMs ?? 600_000) / 1000}s`));
    }, options.timeoutMs ?? 600_000);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Could not start pac (is the Power Platform CLI installed and on PATH?): ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** Run pac and throw with a readable message on failure; hints at auth problems. */
export async function pacOrThrow(args: string[], options?: { cwd?: string; timeoutMs?: number }): Promise<string> {
  const res = await pac(args, options);
  const out = `${res.stdout}\n${res.stderr}`;
  if (res.code !== 0 || /^\s*Error:/m.test(out)) {
    const hint = /auth|profile|login|token/i.test(out)
      ? "\nHint: create a pac auth profile once in a terminal: pac auth create --environment <environment url>"
      : "";
    throw new Error(`pac ${args.slice(0, 2).join(" ")} failed (exit ${res.code}):\n${tail(out, 40)}${hint}`);
  }
  return res.stdout;
}

export function tail(text: string, lines: number): string {
  const all = text.trim().split(/\r?\n/);
  return all.slice(-lines).join("\n");
}
