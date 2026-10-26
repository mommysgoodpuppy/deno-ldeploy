/**
 * One app's lifecycle: building, switching traffic to a new build, rolling
 * back, and watching its branch for new commits.
 *
 * A new build only takes traffic once it's up; the old one keeps serving until
 * then, and a failed build never replaces a working one.
 */

import type { AppConfig, Config } from "./config.ts";
import { build, remoteHead } from "./build.ts";
import { DynamicInstance, freePort, type Instance, StaticInstance } from "./instance.ts";
import { LineLog } from "./log.ts";
import {
  type AppPaths,
  appPaths,
  type AppState,
  type BuildRecord,
  newBuildId,
  readState,
  writeState,
} from "./state.ts";

// Lets in-flight requests to the old build finish before it's stopped.
const DRAIN_MS = 5_000;

export class App {
  readonly paths: AppPaths;
  #state: AppState = { builds: [] };
  #instance: Instance | undefined;
  #building: Promise<BuildRecord> | undefined;
  #appLog: LineLog | undefined;
  #pollTimer: ReturnType<typeof setInterval> | undefined;
  /** Last commit a poll tried, so a broken commit isn't rebuilt every tick. */
  #lastPolled: string | undefined;

  constructor(readonly config: AppConfig, readonly global: Config) {
    this.paths = appPaths(global.dataDir, config.name);
  }

  get name() {
    return this.config.name;
  }

  get instance() {
    return this.#instance;
  }

  async init() {
    this.#state = await readState(this.paths);
    this.#appLog = await new LineLog(this.paths.appLog).open();
    // A daemon restart mid-build leaves a record that will never finish.
    for (const b of this.#state.builds) {
      if (b.status === "building") Object.assign(b, { status: "failed", error: "interrupted" });
    }
    const current = this.#find(this.#state.current);
    if (current) {
      try {
        await this.#activate(current);
      } catch (err) {
        console.error(`${this.name}: couldn't start ${current.id}: ${(err as Error).message}`);
      }
    } else {
      console.log(`${this.name}: no build yet; run \`deno task ldeploy deploy ${this.name}\``);
    }
    this.#lastPolled = this.#state.builds.at(-1)?.commit;
    await this.#save();
    if (this.config.poll > 0) this.#startPolling();
  }

  #find(id: string | undefined) {
    return id ? this.#state.builds.find((b) => b.id === id) : undefined;
  }

  #save() {
    return writeState(this.paths, this.#state);
  }

  /**
   * Builds the branch head and switches to it. `onLine` receives the build log
   * as it's written. Only one build per app runs at a time.
   */
  deploy(onLine?: (line: string) => void): Promise<BuildRecord> {
    if (this.#building) throw new BusyError(`${this.name} is already building`);
    this.#building = this.#deploy(onLine).finally(() => (this.#building = undefined));
    return this.#building;
  }

  async #deploy(onLine?: (line: string) => void): Promise<BuildRecord> {
    const record: BuildRecord = { id: newBuildId(), createdAt: new Date().toISOString(), status: "building" };
    this.#state.builds.push(record);
    await this.#save();

    const log = await new LineLog(this.paths.buildLog(record.id)).open();
    const unsubscribe = onLine ? log.onLine(onLine) : undefined;
    const announce = (line: string) => {
      log.write(line);
      console.log(`${this.name}: ${line}`);
    };
    try {
      announce(`building ${record.id} from ${this.config.source}#${this.config.branch}`);
      const result = await build(this.config, this.paths.build(record.id), log);
      record.commit = result.commit;
      record.settings = result.settings;
      announce(`build ${record.id} done; starting`);
      await this.#activate(record);
      record.status = "ready";
      announce(`${record.id} is live (${result.commit.slice(0, 7)})`);
    } catch (err) {
      record.status = "failed";
      record.error = (err as Error).message;
      announce(`build ${record.id} failed: ${record.error}`);
      await Deno.remove(this.paths.build(record.id), { recursive: true }).catch(() => {});
    } finally {
      unsubscribe?.();
      log.close();
      await this.#save();
      await this.#prune();
    }
    return record;
  }

  /** Starts `record`'s build and moves traffic to it once it's up. */
  async #activate(record: BuildRecord) {
    const runtime = record.settings?.runtime;
    if (!runtime) throw new Error(`${record.id} has no runtime settings`);
    const dir = this.paths.build(record.id);
    const next: Instance = runtime.type === "static"
      ? new StaticInstance(record.id, dir, runtime)
      : new DynamicInstance(record.id, dir, runtime, this.config, this.paths, freePort(), this.#appLog!);

    try {
      await next.start();
    } catch (err) {
      await next.stop();
      throw err;
    }

    const prev = this.#instance;
    this.#instance = next;
    this.#state.current = record.id;
    await this.#save();
    if (prev) {
      setTimeout(() => prev.stop(), prev.buildId === next.buildId ? 0 : DRAIN_MS);
    }
  }

  /** Switches back to `to`, or to the newest working build before the current one. */
  async rollback(to?: string): Promise<BuildRecord> {
    const ready = this.#state.builds.filter((b) => b.status === "ready");
    const currentIdx = ready.findIndex((b) => b.id === this.#state.current);
    const target = to ? ready.find((b) => b.id === to) : ready[currentIdx - 1];
    if (!target) throw new Error(to ? `no ready build ${to}` : "no earlier build to roll back to");
    if (target.id === this.#state.current) return target;
    await this.#activate(target);
    console.log(`${this.name}: rolled back to ${target.id}`);
    return target;
  }

  /** Restarts the live build, e.g. after editing its env file. */
  async restart() {
    const current = this.#find(this.#state.current);
    if (!current) throw new Error(`${this.name} has no live build`);
    // Stop first: a dynamic app's cron jobs shouldn't run twice side by side,
    // and the restart isn't racing a deploy, so the brief gap is fine.
    await this.#instance?.stop();
    this.#instance = undefined;
    await this.#activate(current);
  }

  async stop() {
    clearInterval(this.#pollTimer);
    await this.#instance?.stop();
    this.#appLog?.close();
  }

  #startPolling() {
    const tick = async () => {
      if (this.#building) return;
      try {
        const head = await remoteHead(this.config);
        if (head === this.#lastPolled) return;
        this.#lastPolled = head;
        console.log(`${this.name}: ${this.config.branch} moved to ${head.slice(0, 7)}; deploying`);
        await this.deploy();
      } catch (err) {
        console.error(`${this.name}: poll failed: ${(err as Error).message}`);
      }
    };
    this.#pollTimer = setInterval(tick, this.config.poll * 1000);
    tick();
  }

  /** Deletes old builds beyond `keepBuilds`, never the live one. */
  async #prune() {
    const keep = this.global.keepBuilds;
    const ready = this.#state.builds.filter((b) => b.status === "ready");
    const doomed = new Set(
      ready.slice(0, Math.max(0, ready.length - keep)).map((b) => b.id).filter((id) =>
        id !== this.#state.current
      ),
    );
    // Failed records are only history; keep the last few for their error text.
    const failed = this.#state.builds.filter((b) => b.status === "failed");
    for (const b of failed.slice(0, Math.max(0, failed.length - keep))) doomed.add(b.id);

    for (const id of doomed) {
      await Deno.remove(this.paths.build(id), { recursive: true }).catch(() => {});
      await Deno.remove(this.paths.buildLog(id)).catch(() => {});
    }
    this.#state.builds = this.#state.builds.filter((b) => !doomed.has(b.id));
    await this.#save();
  }

  status() {
    const current = this.#find(this.#state.current);
    return {
      name: this.name,
      source: `${this.config.source}#${this.config.branch}`,
      hostnames: this.config.hostnames,
      building: !!this.#building,
      live: current ? { id: current.id, commit: current.commit, createdAt: current.createdAt } : null,
      instance: this.#instance?.describe() ?? null,
      builds: this.#state.builds.map(({ settings: _, ...b }) => b),
    };
  }
}

export class BusyError extends Error {}
