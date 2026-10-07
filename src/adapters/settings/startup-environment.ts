/**
 * The process environment as it was at start, split into what came from `.env` and what was set
 * outside it (service definition or shell).
 *
 * The process is started with Node's `--env-file`, after which `process.env` cannot tell where a
 * value came from and keeps the start-time value when the file changes. So at start the snapshot
 * compares each variable with the file's value at that moment: equal means "from `.env`", otherwise
 * a non-empty value is "outside" and wins over the file, as `--env-file` itself does. An empty
 * outside value counts as unset (project rule), so the file wins for it. An outside value that
 * happens to equal the file's value is indistinguishable and counts as from `.env`.
 */
import { readFileSync } from "node:fs";
import type { EnvironmentMap } from "../../ports/settings-store.js";
import { parseEnvText } from "./env-file.js";

export class StartupEnvironment {
  readonly #values: ReadonlyMap<string, string>;
  readonly #fromFile: ReadonlySet<string>;
  readonly #outside: ReadonlySet<string>;

  private constructor(values: Map<string, string>, fromFile: Set<string>, outside: Set<string>) {
    this.#values = values;
    this.#fromFile = fromFile;
    this.#outside = outside;
  }

  /** Call once, early at process start, before anything changes the environment. */
  static capture(env: EnvironmentMap, envFile: string): StartupEnvironment {
    let fileValues: Record<string, string>;
    try {
      fileValues = parseEnvText(readFileSync(envFile, "utf8"));
    } catch {
      fileValues = {};
    }
    const values = new Map<string, string>();
    const fromFile = new Set<string>();
    const outside = new Set<string>();
    for (const [name, value] of Object.entries(env)) {
      if (value === undefined) continue;
      values.set(name, value);
      if (fileValues[name] === value) fromFile.add(name);
      else if (value.trim() !== "") outside.add(name);
    }
    return new StartupEnvironment(values, fromFile, outside);
  }

  /** True when `name` was set outside `.env` with a non-empty value; such a setting is locked. */
  isOutside(name: string): boolean {
    return this.#outside.has(name);
  }

  /**
   * The environment a configuration is built from now: the start environment without the values
   * that came from `.env`, then the current file's values for every name not set outside.
   */
  compose(fileValues: Readonly<Record<string, string>>): Record<string, string> {
    const out = Object.create(null) as Record<string, string>;
    for (const [name, value] of this.#values) {
      if (!this.#fromFile.has(name)) out[name] = value;
    }
    for (const [name, value] of Object.entries(fileValues)) {
      if (!this.#outside.has(name)) out[name] = value;
    }
    return out;
  }
}
