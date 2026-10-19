import { TokenProvider } from "./auth/msal.js";
import type { Config, EnvironmentConfig } from "./config.js";
import { DataverseClient } from "./dataverse/client.js";

/** Shared server state: config, one Dataverse client per environment, session-level active solution. */
export class Context {
  readonly tokens: TokenProvider;
  private readonly clients = new Map<string, DataverseClient>();
  private readonly activeSolution = new Map<string, string>();

  constructor(readonly config: Config) {
    this.tokens = new TokenProvider(config);
  }

  envName(name?: string): string {
    const env = name ?? this.config.defaultEnvironment;
    if (!this.config.environments[env]) {
      const known = Object.keys(this.config.environments).join(", ");
      throw new Error(`Unknown environment "${env}". Configured: ${known}`);
    }
    return env;
  }

  env(name?: string): EnvironmentConfig {
    return this.config.environments[this.envName(name)];
  }

  dv(name?: string): DataverseClient {
    const env = this.envName(name);
    let client = this.clients.get(env);
    if (!client) {
      client = new DataverseClient(this.config.environments[env], this.tokens);
      this.clients.set(env, client);
    }
    return client;
  }

  /** Throws unless the environment allows writes. Every write path calls this. */
  assertWritable(name?: string): void {
    const env = this.envName(name);
    if (this.config.environments[env].readOnly) {
      throw new Error(`Environment "${env}" is read-only (readOnly: true in config.json). No changes were made.`);
    }
  }

  solution(name?: string): string | undefined {
    const env = this.envName(name);
    return this.activeSolution.get(env) ?? this.config.environments[env].solution;
  }

  /** Like solution(), but required for writes so components never land in the Default solution. */
  requireSolution(name?: string): string {
    const solution = this.solution(name);
    if (!solution) {
      throw new Error("No working solution set. Call solution_set_active or set `solution` for this environment in config.json.");
    }
    return solution;
  }

  setSolution(name: string | undefined, solution: string): void {
    this.activeSolution.set(this.envName(name), solution);
  }
}
