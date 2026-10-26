import { parse } from "@std/dotenv";
import type { AppConfig } from "./config.ts";

/**
 * The app's own variables: its envFile, then `env` from ldeploy.jsonc on top.
 * Re-read on every build and start, so editing secrets needs only a restart.
 */
export async function loadEnv(app: AppConfig): Promise<Record<string, string>> {
  let fromFile = {};
  if (app.envFile) {
    try {
      fromFile = parse(await Deno.readTextFile(app.envFile));
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) {
        throw new Error(`${app.name}: env file ${app.envFile} doesn't exist`);
      }
      throw err;
    }
  }
  return { ...fromFile, ...app.env };
}
