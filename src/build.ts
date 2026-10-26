/**
 * Turns a commit into a runnable build directory: a fresh clone (submodules
 * included) with the install and build commands run inside it.
 *
 * Unlike Deno Deploy, the checkout is a real clone with a .git, so repos that
 * work around Deploy's missing .git (my-website's fetchsubs) find their
 * submodules already present and skip ahead.
 */

import { dirname, join } from "@std/path";
import { ensureDir } from "@std/fs";
import { loadEnv } from "./env.ts";
import { type AppConfig, type DeploySettings, resolveDeploySettings } from "./config.ts";
import type { LineLog } from "./log.ts";

export interface BuildResult {
  dir: string;
  commit: string;
  settings: DeploySettings;
}

async function run(
  log: LineLog,
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
) {
  log.write(`$ ${[cmd, ...args].join(" ")}`);
  const child = new Deno.Command(cmd, {
    args,
    cwd: opts.cwd,
    env: opts.env,
    clearEnv: !!opts.env,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  await Promise.all([log.pipe(child.stdout, ""), log.pipe(child.stderr, "")]);
  const { code } = await child.status;
  if (code !== 0) throw new Error(`${cmd} ${args[0] ?? ""} exited with code ${code}`);
}

async function capture(cmd: string, args: string[], cwd?: string) {
  const { code, stdout, stderr } = await new Deno.Command(cmd, { args, cwd }).output();
  const dec = new TextDecoder();
  if (code !== 0) throw new Error(`${cmd} ${args.join(" ")}: ${dec.decode(stderr).trim()}`);
  return dec.decode(stdout).trim();
}

/** The commit `branch` currently points at in `source`, without cloning. */
export async function remoteHead(app: AppConfig): Promise<string> {
  const out = await capture("git", ["ls-remote", app.source, `refs/heads/${app.branch}`]);
  const sha = out.split(/\s+/)[0];
  if (!sha) throw new Error(`${app.name}: branch ${app.branch} not found in ${app.source}`);
  return sha;
}

export async function build(
  app: AppConfig,
  dir: string,
  log: LineLog,
): Promise<BuildResult> {
  await run(log, "git", [
    "clone",
    "--depth=1",
    `--branch=${app.branch}`,
    "--recurse-submodules",
    app.source,
    dir,
  ]);
  const commit = await capture("git", ["rev-parse", "HEAD"], dir);
  log.write(`commit ${commit}`);

  const settings = await resolveDeploySettings(dir, app);
  log.write(`settings ${JSON.stringify(settings)}`);

  // Deploy exposes the app's env vars to the build too.
  const env = { ...Deno.env.toObject(), ...(await loadEnv(app)), CI: "true" };
  for (const step of ["install", "build"] as const) {
    const command = settings[step];
    if (command) await run(log, "sh", ["-c", command], { cwd: dir, env });
  }

  const runtime = settings.runtime!;
  if (runtime.type === "static") {
    const stat = await Deno.stat(join(dir, runtime.cwd)).catch(() => null);
    if (!stat?.isDirectory) throw new Error(`static directory ${runtime.cwd} missing after build`);
    // Serving needs only the output; my-website's sources and node_modules
    // are over a gigabyte per kept build.
    const out = `${dir}.out`;
    await Deno.rename(join(dir, runtime.cwd), out);
    await Deno.remove(dir, { recursive: true });
    await ensureDir(dirname(join(dir, runtime.cwd)));
    await Deno.rename(out, join(dir, runtime.cwd));
    log.write(`kept only ${runtime.cwd}/ from the build`);
  } else {
    const entry = join(dir, runtime.cwd ?? ".", runtime.entrypoint);
    if (!(await Deno.stat(entry).catch(() => null))) {
      throw new Error(`entrypoint ${runtime.entrypoint} not found`);
    }
  }

  return { dir, commit, settings };
}
