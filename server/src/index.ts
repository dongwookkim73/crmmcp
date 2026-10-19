#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { Context } from "./context.js";
import { log } from "./log.js";
import { registerCoreTools } from "./tools/core.js";
import { registerMetaTools } from "./tools/meta.js";
import { registerFormTools } from "./tools/forms.js";

async function main(): Promise<void> {
  const ctx = new Context(loadConfig());

  const server = new McpServer(
    { name: "crmmcp", version: "0.1.0" },
    {
      instructions:
        "Dynamics 365 / Dataverse customization tools. Call env_info first. " +
        "Writes are two-step: *_plan tools return a preview and changeToken; show the preview to the user " +
        "and call change_apply only after they approve. Writes are blocked on read-only environments.",
    },
  );

  registerCoreTools(server, ctx);
  registerMetaTools(server, ctx);
  registerFormTools(server, ctx);

  await server.connect(new StdioServerTransport());
  log(`ready (default environment: ${ctx.config.defaultEnvironment})`);
}

main().catch((err) => {
  log("fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
