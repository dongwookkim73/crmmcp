import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

export const envParam = z.string().optional().describe("Environment name from config.json (default: defaultEnvironment)");

export function ok(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

/** Wrap a handler so thrown errors come back as tool errors the model can read and react to. */
export function safe<A>(fn: (args: A) => Promise<unknown>): (args: A) => Promise<CallToolResult> {
  return async (args: A) => {
    try {
      return ok(await fn(args));
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: (err as Error).message }] };
    }
  };
}

/** Drop OData annotation noise but keep FormattedValue as `<field>@display`. */
export function clean<T extends Record<string, any>>(row: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key.endsWith("@OData.Community.Display.V1.FormattedValue")) {
      out[key.replace("@OData.Community.Display.V1.FormattedValue", "@display")] = value;
    } else if (!key.includes("@")) {
      out[key] = value;
    }
  }
  return out;
}
