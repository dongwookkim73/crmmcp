import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PublicClientApplication, type AccountInfo, type Configuration } from "@azure/msal-node";
import { DataProtectionScope, PersistenceCachePlugin, PersistenceCreator } from "@azure/msal-node-extensions";
import type { Config } from "../config.js";
import { log } from "../log.js";

const CACHE_DIR = join(process.env.LOCALAPPDATA ?? join(homedir(), ".cache"), "crmmcp");

function openBrowser(url: string): Promise<void> {
  // rundll32 receives the URL verbatim, avoiding cmd.exe's handling of '&' in query strings.
  const [cmd, args] =
    process.platform === "win32"
      ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
  return Promise.resolve();
}

/**
 * Delegated (signed-in user) tokens for Dataverse. The token cache is encrypted with
 * Windows DPAPI, so after the first browser sign-in the server refreshes silently.
 */
export class TokenProvider {
  private pca?: PublicClientApplication;

  constructor(private readonly config: Config) {}

  private async client(): Promise<PublicClientApplication> {
    if (this.pca) return this.pca;
    mkdirSync(CACHE_DIR, { recursive: true });
    const persistence = await PersistenceCreator.createPersistence({
      cachePath: join(CACHE_DIR, "token-cache.bin"),
      dataProtectionScope: DataProtectionScope.CurrentUser,
      serviceName: "crmmcp",
      accountName: "msal",
      usePlaintextFileOnLinux: false,
    });
    const msalConfig: Configuration = {
      auth: {
        clientId: this.config.clientId,
        authority: `https://login.microsoftonline.com/${this.config.tenantId}`,
      },
      cache: { cachePlugin: new PersistenceCachePlugin(persistence) },
    };
    this.pca = new PublicClientApplication(msalConfig);
    return this.pca;
  }

  async getToken(environmentUrl: string): Promise<string> {
    const pca = await this.client();
    const scopes = [`${environmentUrl}/.default`];
    const accounts = await pca.getTokenCache().getAllAccounts();
    const account: AccountInfo | undefined = accounts.find((a) => a.tenantId === this.config.tenantId) ?? accounts[0];

    if (account) {
      try {
        const result = await pca.acquireTokenSilent({ account, scopes });
        if (result?.accessToken) return result.accessToken;
      } catch (err) {
        log("silent token acquisition failed, falling back to sign-in:", (err as Error).message);
      }
    }

    if (this.config.auth.flow === "deviceCode") {
      const result = await pca.acquireTokenByDeviceCode({
        scopes,
        deviceCodeCallback: (r) => log(r.message),
      });
      if (!result?.accessToken) throw new Error("Device code sign-in returned no token.");
      return result.accessToken;
    }

    log("opening browser for sign-in...");
    const result = await pca.acquireTokenInteractive({
      scopes,
      openBrowser,
      successTemplate: "<h3>crmmcp: signed in. You can close this tab.</h3>",
      errorTemplate: "<h3>crmmcp: sign-in failed: {error}</h3>",
    });
    return result.accessToken;
  }
}
