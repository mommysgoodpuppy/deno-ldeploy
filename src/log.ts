import { dirname } from "@std/path";
import { ensureDir } from "@std/fs";

/** Appends timestamped lines to a file, and optionally echoes them elsewhere. */
export class LineLog {
  #file: Deno.FsFile | undefined;
  #encoder = new TextEncoder();
  #listeners = new Set<(line: string) => void>();

  constructor(readonly path: string, readonly prefix = "") {}

  async open() {
    await ensureDir(dirname(this.path));
    this.#file = await Deno.open(this.path, { append: true, create: true });
    return this;
  }

  onLine(fn: (line: string) => void) {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  write(line: string) {
    const stamped = `${new Date().toISOString()} ${this.prefix}${line}`;
    this.#file?.writeSync(this.#encoder.encode(stamped + "\n"));
    for (const fn of this.#listeners) fn(stamped);
  }

  /** Copies a process stream into the log, one line at a time. */
  async pipe(stream: ReadableStream<Uint8Array>, tag: string) {
    const lines = stream.pipeThrough(new TextDecoderStream()).pipeThrough(splitLines());
    for await (const line of lines) this.write(`${tag}${line}`);
  }

  close() {
    this.#file?.close();
    this.#file = undefined;
  }
}

function splitLines() {
  let rest = "";
  return new TransformStream<string, string>({
    transform(chunk, controller) {
      const parts = (rest + chunk).split(/\r?\n/);
      rest = parts.pop()!;
      for (const part of parts) controller.enqueue(part);
    },
    flush(controller) {
      if (rest) controller.enqueue(rest);
    },
  });
}
