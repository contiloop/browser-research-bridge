/**
 * The last helper check: `data/helper-check.json` holds `{ version: 1, at, runtime, result, message }`
 * (`result` is the check code, `message` the runtime's own text for "Details"). It survives core and
 * process restarts so the automatic check can tell whether the runtime in use already passed once.
 * Written atomically, owner-only; a missing or unreadable file is "no check recorded".
 *
 * Values are stored as given; which runtimes and codes are valid is the caller's business.
 */
import { join } from "node:path";
import { SerialQueue, readJsonFile, writeJsonAtomic } from "./json-file.js";

/** The runtime's message is kept for "Details" only; longer text is clipped. */
export const MAX_HELPER_CHECK_MESSAGE = 2000;

export interface HelperCheckRecord {
  /** ISO time of the check. */
  at: string;
  /** The runtime tried, or null when none was available. */
  runtime: string | null;
  /** The check code (`ok`, `not_installed`, `not_signed_in`, `limit_reached`, `failed`). */
  result: string;
  message: string | null;
}

interface HelperCheckFile extends HelperCheckRecord {
  version: 1;
}

/** Default location of the record inside the data dir. */
export function helperCheckPath(dataDir: string): string {
  return join(dataDir, "helper-check.json");
}

export class FileHelperCheckStore {
  private readonly queue = new SerialQueue();

  constructor(readonly filePath: string) {}

  /** The last record, or null when none is stored or the file cannot be used. */
  load(): Promise<HelperCheckRecord | null> {
    return this.queue.run(async () => {
      let raw: unknown;
      try {
        raw = await readJsonFile(this.filePath);
      } catch {
        return null;
      }
      return parseRecord(raw);
    });
  }

  save(record: HelperCheckRecord): Promise<void> {
    const file: HelperCheckFile = {
      version: 1,
      at: record.at,
      runtime: record.runtime,
      result: record.result,
      message: record.message === null ? null : record.message.slice(0, MAX_HELPER_CHECK_MESSAGE),
    };
    return this.queue.run(() => writeJsonAtomic(this.filePath, file));
  }
}

function parseRecord(raw: unknown): HelperCheckRecord | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  if (v["version"] !== 1) return null;
  const { at, runtime, result, message } = v;
  if (typeof at !== "string" || typeof result !== "string") return null;
  if (runtime !== null && typeof runtime !== "string") return null;
  if (message !== null && typeof message !== "string") return null;
  return { at, runtime, result, message };
}
