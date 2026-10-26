/**
 * ldeploy: a local stand-in for Deno Deploy.
 *
 *   ldeploy serve                    run the daemon
 *   ldeploy status [app]             what's live, and the build history
 *   ldeploy deploy <app>             build the branch head and switch to it
 *   ldeploy rollback <app> [build]   back to the previous (or a given) build
 *   ldeploy restart <app>            restart the live build (re-reads its env)
 *   ldeploy logs <app> [-f]          the app's output
 *   ldeploy build-log <app> [build]  a build's install/build output
 */

import { loadConfig } from "./src/config.ts";
import { serve } from "./src/server.ts";
import { appPaths, readState } from "./src/state.ts";

const USAGE = `usage: ldeploy <serve|status|deploy|rollback|restart|logs|build-log> [app] [...]`;

async function api(path: string, method = "GET") {
  const { control } = await loadConfig();
  try {
    const res = await fetch(`http://${control.hostname}:${control.port}${path}`, { method });
    if (!res.ok) {
      console.error((await res.text()).trim());
      Deno.exit(1);
    }
    return res;
  } catch (err) {
    if (err instanceof TypeError) {
      console.error(
        `can't reach the daemon on ${control.hostname}:${control.port}; is \`ldeploy serve\` running?`,
      );
      Deno.exit(1);
    }
    throw err;
  }
}

// deno-lint-ignore no-explicit-any
function printStatus(app: any) {
  const live = app.live ? `${app.live.id} @ ${app.live.commit?.slice(0, 7)}` : "nothing live";
  console.log(`${app.name}${app.building ? " (building)" : ""}: ${live}`);
  console.log(`  source    ${app.source}`);
  console.log(`  hosts     ${[...app.hostnames, `${app.name}.localhost`].join(", ")}`);
  if (app.instance) console.log(`  instance  ${JSON.stringify(app.instance)}`);
  for (const b of app.builds.slice(-5)) {
    const mark = app.live?.id === b.id ? "*" : " ";
    console.log(
      `  ${mark} ${b.id}  ${b.status.padEnd(8)} ${b.commit?.slice(0, 7) ?? "       "}  ${b.error ?? ""}`,
    );
  }
}

async function tail(path: string, follow: boolean) {
  const args = ["-n", "200", ...(follow ? ["-F"] : []), path];
  const { code } = await new Deno.Command("tail", { args }).spawn().status;
  Deno.exit(code);
}

const [command, name, ...rest] = Deno.args;
const needApp = () => {
  if (!name) {
    console.error(`${command} needs an app name`);
    Deno.exit(2);
  }
  return encodeURIComponent(name);
};

switch (command) {
  case "serve":
    await serve();
    break;

  case "status": {
    const res = await api(name ? `/apps/${needApp()}` : "/apps");
    const body = await res.json();
    for (const app of name ? [body] : body.apps) printStatus(app);
    break;
  }

  case "deploy": {
    const res = await api(`/apps/${needApp()}/deploy`, "POST");
    // Only the tail is kept: the last line says whether the deploy worked.
    let tail = "";
    for await (const chunk of res.body!.pipeThrough(new TextDecoderStream())) {
      Deno.stdout.writeSync(new TextEncoder().encode(chunk));
      tail = (tail + chunk).slice(-4096);
    }
    Deno.exit(tail.trimEnd().split("\n").at(-1)!.startsWith("ok ") ? 0 : 1);
    break;
  }

  case "rollback": {
    const to = rest[0] ?? "";
    const res = await api(`/apps/${needApp()}/rollback${to ? `?to=${encodeURIComponent(to)}` : ""}`, "POST");
    console.log(`live: ${(await res.json()).id}`);
    break;
  }

  case "restart":
    printStatus(await (await api(`/apps/${needApp()}/restart`, "POST")).json());
    break;

  // These read the files directly, so they work while the daemon is down.
  case "logs": {
    const paths = appPaths((await loadConfig()).dataDir, needApp());
    await tail(paths.appLog, rest.includes("-f"));
    break;
  }

  case "build-log": {
    const paths = appPaths((await loadConfig()).dataDir, needApp());
    const id = rest[0] ?? (await readState(paths)).builds.at(-1)?.id;
    if (!id) {
      console.error(`${name} has no builds`);
      Deno.exit(1);
    }
    await tail(paths.buildLog(id), false);
    break;
  }

  default:
    console.error(USAGE);
    Deno.exit(2);
}
