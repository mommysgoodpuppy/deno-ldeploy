/**
 * Per-app records on disk, under <dataDir>/apps/<name>/:
 *
 *   state.json        which build is live, plus the build history
 *   builds/<id>/      one immutable checkout per build
 *   logs/<id>.log     that build's install/build output
 *   app.log           stdout/stderr of the running app, across builds
 *   kv.sqlite3        the app's Deno.openKv() database, shared by every build
 */

import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import type { DeploySettings } from "./config.ts";

export interface BuildRecord {
  id: string;
  commit?: string;
  createdAt: string;
  status: "building" | "ready" | "failed";
  error?: string;
  /** What the build resolved from deno.json and ldeploy.jsonc; needed to restart it. */
  settings?: DeploySettings;
}

export interface AppState {
  current?: string;
  builds: BuildRecord[];
}

export class AppPaths {
  constructor(readonly root: string) {}
  get state() {
    return join(this.root, "state.json");
  }
  get builds() {
    return join(this.root, "builds");
  }
  build(id: string) {
    return join(this.builds, id);
  }
  buildLog(id: string) {
    return join(this.root, "logs", `${id}.log`);
  }
  get appLog() {
    return join(this.root, "app.log");
  }
  get kv() {
    return join(this.root, "kv.sqlite3");
  }
}

export function appPaths(dataDir: string, app: string) {
  return new AppPaths(join(dataDir, "apps", app));
}

export async function readState(paths: AppPaths): Promise<AppState> {
  try {
    return JSON.parse(await Deno.readTextFile(paths.state));
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return { builds: [] };
    throw err;
  }
}

export async function writeState(paths: AppPaths, state: AppState) {
  await ensureDir(paths.root);
  // Write then rename, so a crash mid-write can't lose track of the live build.
  const tmp = `${paths.state}.tmp`;
  await Deno.writeTextFile(tmp, JSON.stringify(state, null, 2) + "\n");
  await Deno.rename(tmp, paths.state);
}

/** Sortable and readable: 20261026-095301-3f2a. */
export function newBuildId() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const rand = crypto.getRandomValues(new Uint8Array(2));
  return `${stamp}-${[...rand].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}
