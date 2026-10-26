/**
 * A running build. Static builds are served from this process; dynamic builds
 * are a supervised `deno run` child that gets restarted if it dies.
 */

import { join } from "@std/path";
import { serveDir, serveFile } from "@std/http/file-server";
import type { AppConfig, Runtime } from "./config.ts";
import { loadEnv } from "./env.ts";
import type { LineLog } from "./log.ts";
import { forward, upstreamClient } from "./proxy.ts";
import type { AppPaths } from "./state.ts";

export interface Instance {
  readonly buildId: string;
  /** Resolves once the build can take traffic. */
  start(): Promise<void>;
  handle(req: Request, info: Deno.ServeHandlerInfo): Promise<Response>;
  stop(): Promise<void>;
  describe(): Record<string, unknown>;
}

export class StaticInstance implements Instance {
  readonly root: string;

  constructor(
    readonly buildId: string,
    buildDir: string,
    readonly runtime: Extract<Runtime, { type: "static" }>,
  ) {
    this.root = join(buildDir, runtime.cwd);
  }

  async start() {}

  async handle(req: Request): Promise<Response> {
    const res = await serveDir(req, { fsRoot: this.root, quiet: true });
    if (res.status === 404 && this.runtime.spa && req.method === "GET") {
      return serveFile(req, join(this.root, "index.html"));
    }
    return res;
  }

  async stop() {}

  describe() {
    return { type: "static", root: this.root, spa: !!this.runtime.spa };
  }
}

const READY_TIMEOUT_MS = 60_000;
const STOP_GRACE_MS = 10_000;

export class DynamicInstance implements Instance {
  #child: Deno.ChildProcess | undefined;
  #stopping = false;
  #restarts = 0;
  #startedAt = 0;
  #listening = false;
  #client: Deno.HttpClient;
  readonly cwd: string;

  constructor(
    readonly buildId: string,
    buildDir: string,
    readonly runtime: Extract<Runtime, { type: "dynamic" }>,
    readonly app: AppConfig,
    readonly paths: AppPaths,
    readonly port: number,
    readonly log: LineLog,
  ) {
    this.cwd = join(buildDir, runtime.cwd ?? ".");
    this.#client = upstreamClient(port);
  }

  async #spawn() {
    const env = {
      ...Deno.env.toObject(),
      ...(await loadEnv(this.app)),
      // Deno.serve() with no options binds here instead of :8000.
      DENO_SERVE_ADDRESS: `tcp:127.0.0.1:${this.port}`,
      PORT: String(this.port),
      // Without this the default database is keyed by the entrypoint path,
      // which changes with every build.
      DENO_KV_DEFAULT_PATH: this.paths.kv,
      DENO_DEPLOYMENT_ID: this.buildId,
      DENO_REGION: "local",
    };
    const args = ["run", ...this.app.denoFlags, this.runtime.entrypoint, ...(this.runtime.args ?? [])];
    this.log.write(`[ldeploy] starting ${this.buildId}: deno ${args.join(" ")} (port ${this.port})`);
    const child = new Deno.Command(Deno.execPath(), {
      args,
      cwd: this.cwd,
      env,
      clearEnv: true,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    this.#child = child;
    this.#startedAt = Date.now();
    this.log.pipe(child.stdout, `[${this.buildId}] `);
    this.log.pipe(child.stderr, `[${this.buildId}] `);
    child.status.then((status) => this.#onExit(child, status));
    return child;
  }

  async #onExit(child: Deno.ChildProcess, status: Deno.CommandStatus) {
    if (child !== this.#child) return;
    this.log.write(
      `[ldeploy] ${this.buildId} exited with code ${status.code}${
        status.signal ? ` (${status.signal})` : ""
      }`,
    );
    if (this.#stopping) return;
    // Back off on repeated crashes; a run of a minute or more resets the count.
    if (Date.now() - this.#startedAt > 60_000) this.#restarts = 0;
    const delay = Math.min(1000 * 2 ** this.#restarts, 60_000);
    this.#restarts++;
    this.log.write(`[ldeploy] restarting in ${delay / 1000}s`);
    await new Promise((r) => setTimeout(r, delay));
    if (!this.#stopping) await this.#spawn();
  }

  async start() {
    const child = await this.#spawn();
    let exited = false;
    child.status.then(() => (exited = true));
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (exited) throw new Error(`${this.buildId} exited during startup; see app log`);
      try {
        const conn = await Deno.connect({ hostname: "127.0.0.1", port: this.port });
        conn.close();
        this.#listening = true;
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    // A cron-only app may never listen. Running is good enough for it.
    this.log.write(
      `[ldeploy] ${this.buildId} isn't listening after ${READY_TIMEOUT_MS / 1000}s; treating it as up`,
    );
  }

  handle(req: Request, info: Deno.ServeHandlerInfo) {
    return forward(req, this.port, this.#client, info);
  }

  async stop() {
    this.#stopping = true;
    this.#client.close();
    const child = this.#child;
    if (!child) return;
    try {
      child.kill("SIGTERM");
    } catch {
      return; // already gone
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // exited in the meantime
      }
    }, STOP_GRACE_MS);
    await child.status;
    clearTimeout(timer);
  }

  describe() {
    return {
      type: "dynamic",
      entrypoint: this.runtime.entrypoint,
      port: this.port,
      pid: this.#child?.pid,
      listening: this.#listening,
      restarts: this.#restarts,
      upSince: new Date(this.#startedAt).toISOString(),
    };
  }
}

/** A port nothing is listening on right now. */
export function freePort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const { port } = listener.addr as Deno.NetAddr;
  listener.close();
  return port;
}
