/**
 * Dynamic DNS for names that point straight at this machine's connection
 * rather than through the tunnel: every `interval` seconds, look up the public
 * IPv4 address and set each listed Cloudflare A record to it if it differs.
 * Each record keeps its proxied setting and TTL.
 *
 * Tunnel-served hostnames don't need this; cloudflared connects outward, so
 * their DNS never contains this machine's address.
 */

import type { DdnsConfig } from "./config.ts";

const API = "https://api.cloudflare.com/client/v4";

// Two independent sources, so one being down doesn't stall updates.
const IP_SOURCES = [
  async () => (await text("https://1.1.1.1/cdn-cgi/trace")).match(/^ip=(.*)$/m)?.[1],
  async () => (await text("https://api.ipify.org")).trim(),
];

async function text(url: string) {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.text();
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export async function publicIPv4(): Promise<string> {
  const errors = [];
  for (const source of IP_SOURCES) {
    try {
      const ip = await source();
      if (ip && IPV4.test(ip)) return ip;
      errors.push(`unexpected answer ${JSON.stringify(ip)}`);
    } catch (err) {
      errors.push((err as Error).message);
    }
  }
  throw new Error(`couldn't determine the public IP: ${errors.join("; ")}`);
}

interface DnsRecord {
  id: string;
  name: string;
  type: string;
  content: string;
}

export class Ddns {
  #token = "";
  #zoneId = "";
  #timer: ReturnType<typeof setInterval> | undefined;
  #state: {
    ip: string | null;
    checkedAt: string | null;
    changedAt: string | null;
    error: string | null;
    records: Record<string, string>;
  } = { ip: null, checkedAt: null, changedAt: null, error: null, records: {} };

  constructor(readonly config: DdnsConfig) {}

  async #api<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${this.#token}`, "content-type": "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.json();
    if (!body.success) {
      const why = body.errors?.map((e: { message: string }) => e.message).join("; ") || res.status;
      throw new Error(`Cloudflare ${init.method ?? "GET"} ${path}: ${why}`);
    }
    return body.result;
  }

  async start() {
    this.#token = (await Deno.readTextFile(this.config.tokenFile)).trim();
    const zones = await this.#api<{ id: string }[]>(`/zones?name=${encodeURIComponent(this.config.zone)}`);
    if (!zones[0]) throw new Error(`ddns: zone ${this.config.zone} isn't visible to this token`);
    this.#zoneId = zones[0].id;
    console.log(`ddns: keeping ${this.config.records.join(", ")} on this machine's IP`);
    await this.check();
    this.#timer = setInterval(() => this.check(), this.config.interval * 1000);
  }

  stop() {
    clearInterval(this.#timer);
  }

  /** Brings every record in line with the current public IP. */
  async check() {
    try {
      const ip = await publicIPv4();
      if (this.#state.ip && ip !== this.#state.ip) {
        console.log(`ddns: public IP changed ${this.#state.ip} -> ${ip}`);
      }
      for (const name of this.config.records) {
        const [record] = await this.#api<DnsRecord[]>(
          `/zones/${this.#zoneId}/dns_records?type=A&name=${encodeURIComponent(name)}`,
        );
        if (!record) throw new Error(`no A record named ${name}; create it once in the dashboard`);
        if (record.content !== ip) {
          // PATCH changes only the address; proxied, TTL and comment stay as set.
          await this.#api(`/zones/${this.#zoneId}/dns_records/${record.id}`, {
            method: "PATCH",
            body: JSON.stringify({ content: ip }),
          });
          console.log(`ddns: ${name} ${record.content} -> ${ip}`);
          this.#state.changedAt = new Date().toISOString();
        }
        this.#state.records[name] = ip;
      }
      this.#state = { ...this.#state, ip, checkedAt: new Date().toISOString(), error: null };
    } catch (err) {
      this.#state.error = (err as Error).message;
      console.error(`ddns: ${this.#state.error}`);
    }
  }

  status() {
    return { zone: this.config.zone, interval: this.config.interval, ...this.#state };
  }
}
