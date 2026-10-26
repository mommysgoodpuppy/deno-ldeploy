/** Forwards a public request to an app process listening on localhost. */

const HOP_BY_HOP = [
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
];

/**
 * An HTTP client that sends every request to the app's port as if the port
 * were a forward proxy. Deno's fetch won't let a Host header be set, but in
 * proxy form the request line carries the public URL, so the app sees the
 * real hostname in both `Host` and `req.url`.
 */
export function upstreamClient(port: number) {
  return Deno.createHttpClient({ proxy: { url: `http://127.0.0.1:${port}` } });
}

export async function forward(
  req: Request,
  port: number,
  client: Deno.HttpClient,
  info: Deno.ServeHandlerInfo,
): Promise<Response> {
  const url = new URL(req.url);

  if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
    return forwardWebSocket(req, new URL(url.pathname + url.search, `ws://127.0.0.1:${port}`));
  }

  const headers = new Headers(req.headers);
  for (const name of HOP_BY_HOP) headers.delete(name);
  const remote = (info.remoteAddr as Deno.NetAddr).hostname;
  // Behind a tunnel these are already set; append rather than overwrite.
  const xff = headers.get("x-forwarded-for");
  headers.set("x-forwarded-for", xff ? `${xff}, ${remote}` : remote);
  if (!headers.has("x-forwarded-proto")) headers.set("x-forwarded-proto", url.protocol.slice(0, -1));
  if (!headers.has("x-forwarded-host")) headers.set("x-forwarded-host", url.host);

  try {
    // Always plain http: an https URL would make the client tunnel with CONNECT.
    const res = await fetch(`http://${url.host}${url.pathname}${url.search}`, {
      client,
      method: req.method,
      headers,
      body: req.body,
      redirect: "manual",
    });
    const out = new Headers(res.headers);
    for (const name of HOP_BY_HOP) out.delete(name);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
  } catch (err) {
    return new Response(`upstream error: ${(err as Error).message}\n`, { status: 502 });
  }
}

function forwardWebSocket(req: Request, target: URL): Response {
  const protocols = req.headers.get("sec-websocket-protocol")?.split(",").map((p) => p.trim());
  const upstream = new WebSocket(target, protocols);
  const { socket, response } = Deno.upgradeWebSocket(req, {
    protocol: protocols?.[0],
  });

  // Messages from the client can arrive before the upstream connection opens.
  const pending: (string | ArrayBufferLike | Blob | ArrayBufferView)[] = [];
  upstream.binaryType = "arraybuffer";
  socket.binaryType = "arraybuffer";
  upstream.onopen = () => {
    for (const msg of pending.splice(0)) upstream.send(msg);
  };
  socket.onmessage = (e) => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(e.data);
    else pending.push(e.data);
  };
  upstream.onmessage = (e) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(e.data);
  };
  const closeBoth = (code?: number, reason?: string) => {
    // 1005/1006 are reserved and can't be sent in a close frame.
    const sendable = code && code !== 1005 && code !== 1006 ? code : 1000;
    for (const ws of [socket, upstream]) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        try {
          ws.close(sendable, reason);
        } catch {
          // already closing
        }
      }
    }
  };
  socket.onclose = (e) => closeBoth(e.code, e.reason);
  upstream.onclose = (e) => closeBoth(e.code, e.reason);
  socket.onerror = () => closeBoth(1011);
  upstream.onerror = () => closeBoth(1011);
  return response;
}
