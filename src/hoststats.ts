/**
 * Live hardware stats for apps that opt in with `hostStats`, read from /proc
 * and /sys (Linux only). Samples every few seconds in the background so each
 * request is cheap and rates (CPU, network) have a window to be measured over.
 *
 * It's public, so it reports only how busy the machine is, never what it is:
 * no hardware model, CPU, OS, kernel version, uptime (which dates the running
 * kernel), capacities, IPs, hostname, users or processes. Anything that would
 * help match the machine against a vulnerability announcement stays out.
 */

const SAMPLE_MS = 5_000;
const HISTORY = 120; // 10 minutes of samples
const DISK_EVERY_MS = 60_000;

interface Sample {
  t: number;
  cpu: number | null;
  temp: number | null;
  mem: number | null;
  rx: number | null;
  tx: number | null;
}

async function read(path: string): Promise<string | null> {
  try {
    return (await Deno.readTextFile(path)).trim();
  } catch {
    return null;
  }
}

/** A directory's entries, or none if it doesn't exist. */
async function* entries(path: string): AsyncIterable<Deno.DirEntry> {
  try {
    yield* Deno.readDir(path);
  } catch {
    // missing on this machine
  }
}

async function readNumber(path: string): Promise<number | null> {
  const text = await read(path);
  const n = text === null ? NaN : Number(text);
  return Number.isFinite(n) ? n : null;
}

async function cpuTimes() {
  const line = (await read("/proc/stat"))?.split("\n")[0];
  if (!line?.startsWith("cpu ")) return null;
  const [user, nice, system, idle, iowait = 0, irq = 0, softirq = 0, steal = 0] = line
    .split(/\s+/).slice(1).map(Number);
  return {
    busy: user + nice + system + irq + softirq + steal,
    total: user + nice + system + idle + iowait + irq + softirq + steal,
  };
}

/** The interface the default route uses. */
async function defaultInterface(): Promise<string | null> {
  for (const line of (await read("/proc/net/route"))?.split("\n").slice(1) ?? []) {
    const [iface, dest] = line.split(/\s+/);
    if (dest === "00000000") return iface;
  }
  return null;
}

async function interfaceBytes(iface: string) {
  for (const line of (await read("/proc/net/dev"))?.split("\n") ?? []) {
    const [name, rest] = line.split(":");
    if (name?.trim() !== iface || !rest) continue;
    const fields = rest.trim().split(/\s+/).map(Number);
    return { rx: fields[0], tx: fields[8] };
  }
  return null;
}

/** CPU package temperature in °C, from the first CPU sensor found. */
async function cpuTemp(): Promise<number | null> {
  const CPU_SENSORS = ["coretemp", "k10temp", "zenpower", "cpu_thermal", "acpitz"];
  let best: { rank: number; temp: number } | null = null;
  for await (const dir of entries("/sys/class/hwmon")) {
    const base = `/sys/class/hwmon/${dir.name}`;
    const rank = CPU_SENSORS.indexOf((await read(`${base}/name`)) ?? "");
    if (rank === -1 || (best && best.rank <= rank)) continue;
    let max: number | null = null;
    for await (const f of Deno.readDir(base)) {
      if (!/^temp\d+_input$/.test(f.name)) continue;
      const milli = await readNumber(`${base}/${f.name}`);
      if (milli !== null && (max === null || milli > max)) max = milli;
    }
    if (max !== null) best = { rank, temp: max / 1000 };
  }
  return best?.temp ?? null;
}

/** Wi-Fi signal for `iface`, if it's wireless. */
async function wifi(iface: string) {
  for (const line of (await read("/proc/net/wireless"))?.split("\n").slice(2) ?? []) {
    const [name, rest] = line.split(":");
    if (name?.trim() !== iface || !rest) continue;
    const [, quality, level] = rest.trim().split(/\s+/);
    return { quality: Math.round((parseFloat(quality) / 70) * 100), dbm: parseFloat(level) };
  }
  return null;
}

/** RAM and swap in use, as percentages; sizes would describe the hardware. */
async function memory() {
  const info = new Map<string, number>();
  for (const line of (await read("/proc/meminfo"))?.split("\n") ?? []) {
    const [key, value] = line.split(":");
    if (value) info.set(key, parseInt(value));
  }
  const percent = (used: number, total: number) => (total > 0 ? (100 * used) / total : null);
  const total = info.get("MemTotal") ?? 0;
  const swapTotal = info.get("SwapTotal") ?? 0;
  return {
    usedPercent: percent(total - (info.get("MemAvailable") ?? total), total),
    swapPercent: percent(swapTotal - (info.get("SwapFree") ?? swapTotal), swapTotal),
  };
}

/** Root filesystem use, as a percentage. */
async function diskPercent(): Promise<number | null> {
  try {
    const { stdout } = await new Deno.Command("df", { args: ["-B1", "--output=size,used", "/"] }).output();
    const [size, used] = new TextDecoder().decode(stdout).trim().split("\n")[1].trim().split(/\s+/).map(
      Number,
    );
    return size > 0 ? (100 * used) / size : null;
  } catch {
    return null;
  }
}

export class HostStats {
  #history: Sample[] = [];
  #lastCpu: { busy: number; total: number } | null = null;
  #lastNet: { t: number; rx: number; tx: number } | null = null;
  #iface: string | null = null;
  #disk: number | null = null;
  #timers: ReturnType<typeof setInterval>[] = [];

  async start() {
    this.#iface = await defaultInterface();
    this.#disk = await diskPercent();
    await this.#sample();
    this.#timers.push(setInterval(() => this.#sample(), SAMPLE_MS));
    this.#timers.push(setInterval(async () => (this.#disk = await diskPercent()), DISK_EVERY_MS));
  }

  stop() {
    for (const t of this.#timers) clearInterval(t);
  }

  async #sample() {
    const t = Date.now();
    const cpu = await cpuTimes();
    let cpuPercent: number | null = null;
    if (cpu && this.#lastCpu && cpu.total > this.#lastCpu.total) {
      cpuPercent = (100 * (cpu.busy - this.#lastCpu.busy)) / (cpu.total - this.#lastCpu.total);
    }
    this.#lastCpu = cpu;

    // The default route can move (e.g. Wi-Fi to ethernet), so re-check it.
    this.#iface = (await defaultInterface()) ?? this.#iface;
    const bytes = this.#iface ? await interfaceBytes(this.#iface) : null;
    let rx: number | null = null, tx: number | null = null;
    if (bytes && this.#lastNet && t > this.#lastNet.t && bytes.rx >= this.#lastNet.rx) {
      const secs = (t - this.#lastNet.t) / 1000;
      rx = (bytes.rx - this.#lastNet.rx) / secs;
      tx = (bytes.tx - this.#lastNet.tx) / secs;
    }
    this.#lastNet = bytes ? { t, ...bytes } : null;

    const mem = (await memory()).usedPercent;
    this.#history.push({ t, cpu: cpuPercent, temp: await cpuTemp(), mem, rx, tx });
    if (this.#history.length > HISTORY) this.#history.shift();
  }

  async snapshot(apps: Record<string, unknown>[]) {
    const latest = this.#history.at(-1);
    const [load1, load5, load15] = Deno.loadavg();
    return {
      load: [load1, load5, load15],
      cpuPercent: latest?.cpu ?? null,
      tempC: latest?.temp ?? null,
      memory: await memory(),
      diskPercent: this.#disk,
      network: {
        kind: this.#iface?.startsWith("wl") ? "wifi" : this.#iface ? "wired" : null,
        rxBytesPerSec: latest?.rx ?? null,
        txBytesPerSec: latest?.tx ?? null,
        wifi: this.#iface?.startsWith("wl") ? await wifi(this.#iface) : null,
      },
      sampleSeconds: SAMPLE_MS / 1000,
      history: this.#history,
      apps,
      at: new Date().toISOString(),
    };
  }
}
