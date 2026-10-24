import type { TokenProvider } from "../auth/msal.js";
import type { EnvironmentConfig } from "../config.js";
import { log } from "../log.js";

export interface RequestOptions {
  body?: unknown;
  /** Adds MSCRM.SolutionUniqueName so new components land in this unmanaged solution. */
  solution?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export class DataverseError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

const MAX_RETRIES = 3;
const TIMEOUT_MS = 30_000;
/** Metadata changes and publishing run synchronously on the server and can take minutes (creating a table ~1-3 min). */
const LONG_TIMEOUT_MS = 600_000;
const LONG_RUNNING = /^(EntityDefinitions|RelationshipDefinitions|GlobalOptionSetDefinitions|PublishXml|PublishAllXml|InsertOptionValue|UpdateOptionValue|AddSolutionComponent)/;

/** Thin Dataverse Web API v9.2 client: auth, retry on service-protection limits, error unwrapping. */
export class DataverseClient {
  readonly baseUrl: string;

  constructor(
    readonly env: EnvironmentConfig,
    private readonly tokens: TokenProvider,
  ) {
    this.baseUrl = `${env.url}/api/data/v9.2/`;
  }

  async request<T = any>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const url = path.startsWith("http") ? path : this.baseUrl + path.replace(/^\//, "");

    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${await this.tokens.getToken(this.env.url)}`,
        Accept: "application/json",
        "OData-MaxVersion": "4.0",
        "OData-Version": "4.0",
        Prefer: 'odata.include-annotations="*"',
        ...options.headers,
      };
      if (options.body !== undefined) headers["Content-Type"] = "application/json; charset=utf-8";
      if (options.solution) headers["MSCRM.SolutionUniqueName"] = options.solution;

      const res = await fetch(url, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(options.timeoutMs ?? (method !== "GET" && LONG_RUNNING.test(path) ? LONG_TIMEOUT_MS : TIMEOUT_MS)),
      });

      if ((res.status === 429 || res.status === 503) && attempt < MAX_RETRIES) {
        const wait = Number(res.headers.get("Retry-After") ?? 2 ** attempt) * 1000;
        log(`${res.status} from Dataverse, retrying in ${wait}ms`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }

      if (!res.ok) {
        const text = await res.text();
        let message = text;
        let code: string | undefined;
        try {
          const err = JSON.parse(text).error;
          message = err?.message ?? text;
          code = err?.code;
        } catch {
          // non-JSON error body; keep raw text
        }
        throw new DataverseError(`${method} ${path} -> ${res.status}: ${message}`, res.status, code);
      }

      if (res.status === 204) {
        // Creates return the new record's URI in OData-EntityId.
        const entityId = res.headers.get("OData-EntityId");
        return (entityId ? { entityId, id: entityId.match(/\(([^)]+)\)$/)?.[1] } : {}) as T;
      }
      const text = await res.text();
      return (text ? JSON.parse(text) : {}) as T;
    }
  }

  get<T = any>(path: string, options?: RequestOptions) {
    return this.request<T>("GET", path, options);
  }
  post<T = any>(path: string, body: unknown, options?: RequestOptions) {
    return this.request<T>("POST", path, { ...options, body });
  }
  patch<T = any>(path: string, body: unknown, options?: RequestOptions) {
    return this.request<T>("PATCH", path, { ...options, body });
  }
  put<T = any>(path: string, body: unknown, options?: RequestOptions) {
    return this.request<T>("PUT", path, { ...options, body });
  }
}

/** Escape a value for use inside an OData string literal. */
export function odataString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
