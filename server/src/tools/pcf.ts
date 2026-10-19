import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Context } from "../context.js";
import { odataString } from "../dataverse/client.js";
import { killTree, pacOrThrow, spawnCmd, tail } from "../pac/run.js";
import { bumpVersion, getProject, listProjects, PCF_DIR, projectRoot } from "../pcf/project.js";
import { registerChange } from "../pipeline/changes.js";
import { log } from "../log.js";
import { envParam, safe } from "./util.js";

const projectParam = z.string().describe("PCF project folder name under src/pcf (or namespace.ControlName)");

/** Run a shell command (npm, dotnet) and collect output. */
function run(cmd: string, args: string[], cwd: string, timeoutMs = 600_000): Promise<{ code: number; out: string }> {
  return new Promise((resolvePromise, reject) => {
    log(cmd, args.join(" "), `(in ${cwd})`);
    const child = spawnCmd(cmd, args, { cwd });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${cmd} ${args.join(" ")} timed out`));
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? -1, out });
    });
  });
}

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

/** Pull compiler/linter errors out of build output as "file(line,col): TSxxxx message". */
function buildErrors(out: string): string[] {
  const lines = stripAnsi(out).split(/\r?\n/);
  const errors: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const loc = lines[i].match(/\[tsl\] ERROR in (.+)$/);
    if (loc) errors.push(`${loc[1].trim()}: ${lines[i + 1]?.trim() ?? ""}`);
    else if (/\[pcf-\d+\] \[Error\]|error\s+.+\s+@?[\w/-]+$|^\s*\d+:\d+\s+error\s/.test(lines[i])) errors.push(lines[i].trim());
  }
  return [...new Set(errors)].slice(0, 40);
}

/** npm run build exits 0 even when pcf-scripts reports "[build] Failed", so check the output too. */
function buildFailed(code: number, out: string): boolean {
  return code !== 0 || /\[build\] Failed|\[pcf-\d+\] \[Error\]/.test(stripAnsi(out));
}

const harnesses = new Map<string, { child: ChildProcess; output: string[] }>();

// Don't leave dev servers running when the MCP server exits.
process.on("exit", () => {
  for (const h of harnesses.values()) killTree(h.child);
});

export function registerPcfTools(server: McpServer, ctx: Context): void {
  server.registerTool(
    "pcf_list",
    {
      title: "List PCF projects",
      description: "List local PCF projects under src/pcf with manifest name, version, type and properties.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    safe(async () =>
      listProjects().map((p) => ({
        project: p.name,
        control: `${p.namespace}.${p.constructor}`,
        version: p.version,
        type: p.controlType,
        properties: p.properties.map((x) => `${x.name} (${x.usage}, ${x.ofType}${x.required ? ", required" : ""})`),
        dir: relative(PCF_DIR, p.dir),
        harnessRunning: harnesses.has(p.name),
      })),
    ),
  );

  server.registerTool(
    "pcf_scaffold",
    {
      title: "Create PCF project",
      description:
        "Create a new PCF project with pac pcf init in src/pcf/<name> and run npm install. " +
        "Then edit index.ts / ControlManifest.Input.xml with normal file tools and use pcf_build.",
      inputSchema: {
        name: z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/).describe("Control name, e.g. StatusBadge"),
        namespace: z.string().regex(/^[A-Za-z][A-Za-z0-9.]*$/).optional().describe("Default: publisher prefix (e.g. Dwmcp)"),
        template: z.enum(["field", "dataset"]).default("field"),
        framework: z.enum(["none", "react"]).default("react").describe("react = virtual control using platform React + Fluent"),
      },
    },
    safe(async ({ name, namespace, template, framework }) => {
      const dir = join(PCF_DIR, name);
      if (existsSync(dir) && readdirSync(dir).length) throw new Error(`src/pcf/${name} already exists.`);
      mkdirSync(dir, { recursive: true });
      const ns = namespace ?? ctx.config.publisherPrefix[0].toUpperCase() + ctx.config.publisherPrefix.slice(1);
      await pacOrThrow(
        ["pcf", "init", "--namespace", ns, "--name", name, "--template", template, "--framework", framework, "--outputDirectory", dir, "--run-npm-install"],
        { timeoutMs: 900_000 },
      );
      const p = getProject(name);
      // The template's TypeScript 4.x can't parse the latest @types/node pulled in transitively; pin a compatible one.
      const pin = await run("npm", ["install", "-D", "@types/node@18"], projectRoot(p), 600_000);
      if (pin.code !== 0) log("pinning @types/node failed:", tail(pin.out, 5));
      return {
        project: name,
        control: `${p.namespace}.${p.constructor}`,
        dir: p.dir,
        manifest: p.manifestPath,
        properties: p.properties,
        next: "Edit the manifest and index.ts, then pcf_build; pcf_test_harness to try it locally; pcf_push_plan to deploy to dev.",
      };
    }),
  );

  server.registerTool(
    "pcf_build",
    {
      title: "Build PCF project",
      description: "Run npm run build for a PCF project and return errors (TypeScript, ESLint, manifest validation).",
      inputSchema: { project: projectParam, production: z.boolean().optional() },
    },
    safe(async ({ project, production }) => {
      const p = getProject(project);
      const cwd = projectRoot(p);
      if (!existsSync(join(cwd, "node_modules"))) {
        const install = await run("npm", ["install"], cwd, 900_000);
        if (install.code !== 0) throw new Error(`npm install failed:\n${tail(install.out, 30)}`);
      }
      const res = await run("npm", ["run", "build", ...(production ? ["--", "--buildMode", "production"] : [])], cwd);
      const failed = buildFailed(res.code, res.out);
      const errors = failed ? buildErrors(res.out) : [];
      const typesNode = errors.some((e) => e.includes("@types") && e.includes("node_modules"));
      return {
        ok: !failed,
        errors,
        ...(failed && !errors.length ? { output: tail(stripAnsi(res.out), 30) } : {}),
        ...(typesNode ? { hint: "Errors come from node_modules type definitions newer than the project's TypeScript. Run: npm install -D @types/node@18" } : {}),
      };
    }),
  );

  server.registerTool(
    "pcf_test_harness",
    {
      title: "Start/stop PCF test harness",
      description: "Start (npm start watch) or stop the local PCF test harness for a project; it rebuilds on save. Returns the local URL.",
      inputSchema: { project: projectParam, action: z.enum(["start", "stop", "status"]).default("start") },
    },
    safe(async ({ project, action }) => {
      const p = getProject(project);
      const running = harnesses.get(p.name);
      if (action === "stop") {
        if (!running) return { running: false };
        killTree(running.child);
        harnesses.delete(p.name);
        return { stopped: true };
      }
      if (action === "status") return { running: Boolean(running), recentOutput: running?.output.slice(-15) ?? [] };
      if (running) return { running: true, url: "http://localhost:8181", note: "Already running." };

      const child = spawnCmd("npm", ["start", "watch"], { cwd: projectRoot(p) });
      const output: string[] = [];
      const push = (d: Buffer) => {
        output.push(...d.toString().split(/\r?\n/).filter(Boolean));
        if (output.length > 200) output.splice(0, output.length - 200);
      };
      child.stdout?.on("data", push);
      child.stderr?.on("data", push);
      child.on("close", () => harnesses.delete(p.name));
      harnesses.set(p.name, { child, output });

      // Wait for the dev server to report its URL (or fail) — up to 90s.
      const url = await new Promise<string | undefined>((res) => {
        const started = Date.now();
        const timer = setInterval(() => {
          const line = output.find((l) => /https?:\/\/(localhost|127\.0\.0\.1):\d+/.test(l));
          if (line || !harnesses.has(p.name) || Date.now() - started > 90_000) {
            clearInterval(timer);
            res(line?.match(/https?:\/\/(localhost|127\.0\.0\.1):\d+/)?.[0]);
          }
        }, 1000);
      });
      if (!harnesses.has(p.name)) throw new Error(`Test harness exited:\n${output.slice(-20).join("\n")}`);
      return { running: true, url: url ?? "http://localhost:8181", recentOutput: output.slice(-10) };
    }),
  );

  server.registerTool(
    "pcf_push_plan",
    {
      title: "Plan: push PCF to dev",
      description:
        "Plan deploying a PCF project to the environment with pac pcf push into the working solution. Bumps the manifest patch version by default " +
        "so Dataverse picks up the new build. Returns a changeToken for change_apply.",
      inputSchema: {
        project: projectParam,
        bumpVersion: z.boolean().default(true),
        incremental: z.boolean().optional().describe("Push only changed files (faster, for repeated pushes)"),
        env: envParam,
      },
    },
    safe(async ({ project, bumpVersion: bump, incremental, env }) => {
      ctx.assertWritable(env);
      const solution = ctx.requireSolution(env);
      const p = getProject(project);
      return registerChange({
        tool: "pcf_push",
        env: ctx.envName(env),
        solution,
        summary: `Push ${p.namespace}.${p.constructor} ${p.version}${bump ? " (+patch)" : ""} to ${ctx.envName(env)} solution ${solution}`,
        preview: { control: `${p.namespace}.${p.constructor}`, version: p.version, bumpVersion: bump, solution, environment: ctx.env(env).url },
        execute: async () => {
          const version = bump ? bumpVersion(p.manifestPath) : undefined;
          const out = await pacOrThrow(
            [
              "pcf", "push",
              "--environment", ctx.env(env).url,
              "--publisher-prefix", ctx.config.publisherPrefix,
              "--solution-unique-name", solution,
              ...(incremental ? ["--incremental"] : []),
            ],
            { cwd: projectRoot(p), timeoutMs: 1_200_000 },
          );
          return { pushed: true, version, output: tail(out, 12), next: "Bind it to a form field with form_patch_plan op bindControl." };
        },
      });
    }),
  );

  server.registerTool(
    "pcf_package",
    {
      title: "Package PCF as solution",
      description:
        "Build a deployable solution zip for a PCF project (pac solution init + add-reference + dotnet build) under src/pcf/<project>/solution. " +
        "Use for moving the control to test/prod via solution import.",
      inputSchema: { project: projectParam, managed: z.boolean().default(false) },
    },
    safe(async ({ project, managed }) => {
      const p = getProject(project);
      const solDir = join(p.dir, "solution");
      if (!existsSync(join(solDir, "solution.cdsproj"))) {
        mkdirSync(solDir, { recursive: true });
        await pacOrThrow(["solution", "init", "--publisher-name", ctx.config.publisherPrefix, "--publisher-prefix", ctx.config.publisherPrefix, "--outputDirectory", solDir]);
        await pacOrThrow(["solution", "add-reference", "--path", projectRoot(p)], { cwd: solDir });
      }
      const res = await run("dotnet", ["build", "-c", "Release", `-p:SolutionPackageType=${managed ? "Managed" : "Unmanaged"}`], solDir, 1_200_000);
      if (res.code !== 0) throw new Error(`dotnet build failed:\n${buildErrors(res.out).join("\n") || tail(res.out, 30)}`);
      const binDir = join(solDir, "bin", "Release");
      const zips = existsSync(binDir) ? readdirSync(binDir).filter((f) => f.endsWith(".zip")) : [];
      return { built: true, managed, files: zips.map((z) => join(binDir, z)) };
    }),
  );

  server.registerTool(
    "pcf_list_installed",
    {
      title: "List installed code components",
      description: "List code components (PCF) registered in the environment, optionally filtered by name.",
      inputSchema: { nameContains: z.string().optional(), env: envParam },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ nameContains, env }) => {
      const filter = nameContains ? `&$filter=contains(name,${odataString(nameContains)})` : "";
      const res = await ctx.dv(env).get(`customcontrols?$select=name,version,compatibledatatypes,modifiedon,ismanaged&$orderby=name${filter}&$top=200`);
      return res.value.map((c: any) => ({ name: c.name, version: c.version, dataTypes: c.compatibledatatypes, modifiedOn: c.modifiedon, managed: c.ismanaged }));
    }),
  );
}
