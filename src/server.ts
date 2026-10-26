/**
 * The daemon. Two listeners:
 *
 *   listen   public traffic, routed to an app by Host header. Point the tunnel
 *            or reverse proxy here.
 *   control  the management API the CLI talks to. It can trigger builds, so
 *            keep it on localhost.
 */

import { App, BusyError } from "./app.ts";
import { type Config, loadConfig } from "./config.ts";
import { HostStats } from "./hoststats.ts";
import { Ddns } from "./ddns.ts";

export async function serve() {
  const config = await loadConfig();
  const apps = new Map<string, App>();
  for (const appConfig of config.apps.values()) {
    const app = new App(appConfig, config);
    await app.init();
    apps.set(app.name, app);
  }

  const byHost = new Map<string, App>();
  for (const app of apps.values()) {
    for (const host of app.config.hostnames) byHost.set(host, app);
  }

  // A DDNS failure (bad token, API down) is logged and retried, never fatal:
  // the apps don't depend on it.
  const ddns = config.ddns ? new Ddns(config.ddns) : null;
  await ddns?.start().catch((err) => console.error(`ddns: not started: ${err.message}`));

  // Sampling only runs if some app serves the stats.
  const hostStats = [...apps.values()].some((a) => a.config.hostStats) ? new HostStats() : null;
  await hostStats?.start();
  const startedAt = new Date().toISOString();
  const requests = new Map<string, number>();
  // What the stats endpoint says about the hosted apps: public facts only.
  const appSummaries = () =>
    [...apps.values()].map((a) => {
      const s = a.status();
      return {
        name: a.name,
        type: s.instance?.type ?? null,
        liveSince: s.live?.createdAt ?? null,
        requests: requests.get(a.name) ?? 0,
      };
    });

  const publicServer = Deno.serve({
    ...config.listen,
    onListen: ({ hostname, port }) => console.log(`router on http://${hostname}:${port}`),
  }, async (req, info) => {
    const host = (req.headers.get("host") ?? "").toLowerCase().replace(/:\d+$/, "");
    // <app>.localhost always works, which browsers resolve to loopback.
    const app = byHost.get(host) ?? apps.get(host.replace(/\.localhost$/, ""));
    if (!app) return new Response(`no app serves ${host}\n`, { status: 404 });
    requests.set(app.name, (requests.get(app.name) ?? 0) + 1);
    if (hostStats && req.method === "GET" && new URL(req.url).pathname === app.config.hostStats) {
      const body = { ...(await hostStats.snapshot(appSummaries())), ldeploySince: startedAt };
      return Response.json(body, { headers: { "cache-control": "no-store" } });
    }
    if (!app.instance) return new Response(`${app.name} has no live build\n`, { status: 503 });
    return app.instance.handle(req, info);
  });

  const controlServer = Deno.serve({
    ...config.control,
    onListen: ({ hostname, port }) => console.log(`control on http://${hostname}:${port}`),
  }, (req) => control(req, apps, config, ddns));

  const shutdown = async () => {
    console.log("shutting down");
    hostStats?.stop();
    ddns?.stop();
    await Promise.all([...apps.values()].map((a) => a.stop()));
    await Promise.all([publicServer.shutdown(), controlServer.shutdown()]);
    Deno.exit(0);
  };
  Deno.addSignalListener("SIGINT", shutdown);
  Deno.addSignalListener("SIGTERM", shutdown);
}

async function control(
  req: Request,
  apps: Map<string, App>,
  config: Config,
  ddns: Ddns | null,
): Promise<Response> {
  const url = new URL(req.url);
  const [, resource, name, action] = url.pathname.split("/");

  if (resource !== "apps") return new Response("not found\n", { status: 404 });
  if (!name) {
    return Response.json({
      dataDir: config.dataDir,
      apps: [...apps.values()].map((a) => a.status()),
      ddns: ddns?.status() ?? null,
    });
  }
  const app = apps.get(name);
  if (!app) return new Response(`no app named ${name}\n`, { status: 404 });

  if (req.method === "GET" && !action) return Response.json(app.status());
  if (req.method !== "POST") return new Response("method not allowed\n", { status: 405 });

  try {
    switch (action) {
      case "deploy":
        return streamDeploy(app);
      case "rollback":
        return Response.json(await app.rollback(url.searchParams.get("to") ?? undefined));
      case "restart":
        await app.restart();
        return Response.json(app.status());
    }
  } catch (err) {
    const status = err instanceof BusyError ? 409 : 400;
    return new Response(`${(err as Error).message}\n`, { status });
  }
  return new Response("not found\n", { status: 404 });
}

/** Streams the build log back as plain text; the last line is the outcome. */
function streamDeploy(app: App): Response {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (c) => (controller = c) });
  const send = (line: string) => {
    try {
      controller.enqueue(encoder.encode(line + "\n"));
    } catch {
      // the client went away; the build carries on regardless
    }
  };
  // Throws BusyError synchronously, before any response is committed.
  const done = app.deploy(send);
  done.then((record) => {
    send(record.status === "ready" ? `ok ${record.id}` : `failed ${record.id}: ${record.error}`);
    try {
      controller.close();
    } catch {
      // already closed
    }
  });
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
}
