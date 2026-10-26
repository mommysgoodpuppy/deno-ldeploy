/**
 * ldeploy.jsonc: which apps exist, where their source lives, and which
 * hostnames route to them.
 *
 * How an app builds and runs comes from the `deploy` block in the repo's own
 * deno.json, the same block Deno Deploy reads. An app's `deploy` entry here is
 * merged over it, which covers apps whose settings only ever lived in the
 * Deploy dashboard.
 */

import { parse } from "@std/jsonc";
import { dirname, resolve } from "@std/path";

export type Runtime =
  | {
    type: "dynamic";
    entrypoint: string;
    /** Arguments passed to the script, after the entrypoint. */
    args?: string[];
    /** Directory to run in, relative to the repo root. */
    cwd?: string;
  }
  | {
    type: "static";
    /** Directory to serve, relative to the repo root. */
    cwd: string;
    /** Serve index.html for paths that don't match a file. */
    spa?: boolean;
  };

export interface DeploySettings {
  install?: string;
  build?: string;
  runtime?: Runtime;
}

export interface AppConfig {
  name: string;
  /** Git URL or local repo path. */
  source: string;
  branch: string;
  hostnames: string[];
  /** dotenv file whose variables reach both the build and the app. */
  envFile?: string;
  env: Record<string, string>;
  /** Flags for `deno run` on a dynamic app. */
  denoFlags: string[];
  /** Seconds between checks of `branch` for new commits; 0 disables. */
  poll: number;
  deploy: DeploySettings;
}

export interface Config {
  listen: { hostname: string; port: number };
  control: { hostname: string; port: number };
  dataDir: string;
  keepBuilds: number;
  apps: Map<string, AppConfig>;
}

// Deploy runs with every permission and with KV and cron on, so match it.
const DEFAULT_DENO_FLAGS = ["-A", "--unstable-kv", "--unstable-cron"];

function parseAddress(value: string, fallbackPort: number) {
  const [hostname, port] = value.includes(":") ? value.split(":") : [value, String(fallbackPort)];
  return { hostname: hostname || "127.0.0.1", port: Number(port) };
}

export const CONFIG_PATH = resolve(
  Deno.env.get("LDEPLOY_CONFIG") ?? "ldeploy.jsonc",
);

export async function loadConfig(path = CONFIG_PATH): Promise<Config> {
  // deno-lint-ignore no-explicit-any
  const raw = parse(await Deno.readTextFile(path)) as any;
  // Relative paths in the file are relative to the file, not to the cwd.
  const base = dirname(path);
  const rel = (p: string) => resolve(base, p.replace(/^~(?=\/)/, Deno.env.get("HOME")!));

  const apps = new Map<string, AppConfig>();
  // deno-lint-ignore no-explicit-any
  for (const [name, app] of Object.entries<any>(raw.apps ?? {})) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
      throw new Error(`app name "${name}" must be lowercase letters, digits and dashes`);
    }
    if (!app.source) throw new Error(`${name}: "source" is required`);
    // A source that isn't a URL is a local repo path.
    const source = /^[a-z+]+:\/\/|^git@/.test(app.source) ? app.source : rel(app.source);
    apps.set(name, {
      name,
      source,
      branch: app.branch ?? "main",
      hostnames: (app.hostnames ?? []).map((h: string) => h.toLowerCase()),
      envFile: app.envFile ? rel(app.envFile) : undefined,
      env: app.env ?? {},
      denoFlags: app.denoFlags ?? DEFAULT_DENO_FLAGS,
      poll: app.poll ?? 0,
      deploy: app.deploy ?? {},
    });
  }

  // Two apps claiming one hostname would route nondeterministically.
  const owner = new Map<string, string>();
  for (const app of apps.values()) {
    for (const host of app.hostnames) {
      const prev = owner.get(host);
      if (prev) throw new Error(`hostname ${host} is claimed by both ${prev} and ${app.name}`);
      owner.set(host, app.name);
    }
  }

  return {
    listen: parseAddress(raw.listen ?? "127.0.0.1:8000", 8000),
    control: parseAddress(raw.control ?? "127.0.0.1:8001", 8001),
    dataDir: rel(raw.dataDir ?? "data"),
    keepBuilds: raw.keepBuilds ?? 3,
    apps,
  };
}

/** The repo's deno.json(c) `deploy` block, with the app's overrides merged over it. */
export async function resolveDeploySettings(
  repoDir: string,
  app: AppConfig,
): Promise<DeploySettings> {
  let fromRepo: DeploySettings = {};
  for (const file of ["deno.json", "deno.jsonc"]) {
    try {
      // deno-lint-ignore no-explicit-any
      const json = parse(await Deno.readTextFile(`${repoDir}/${file}`)) as any;
      fromRepo = json?.deploy ?? {};
      break;
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
  }
  const merged = { ...fromRepo, ...app.deploy };
  if (!merged.runtime) {
    throw new Error(
      `${app.name}: no runtime configured; add "deploy.runtime" to the repo's deno.json or to ldeploy.jsonc`,
    );
  }
  return merged;
}
