/**
 * File-backed {@link SiteStateStore}: `data/sites.json` lists every registered site with its
 * lifecycle status and check/failure timestamps. Written atomically; never committed.
 */
import { join } from "node:path";
import { parseSiteRuntimeState } from "../../core/lifecycle.js";
import type { SiteRuntimeState } from "../../core/lifecycle.js";
import type { SiteStateStore } from "../../ports/site-store.js";
import { SerialQueue, readJsonFile, writeJsonAtomic } from "./json-file.js";

interface SitesFile {
  version: 1;
  sites: SiteRuntimeState[];
}

/** Default location of the state file inside the data dir. */
export function siteStatePath(dataDir: string): string {
  return join(dataDir, "sites.json");
}

export class FileSiteStateStore implements SiteStateStore {
  private readonly queue = new SerialQueue();

  constructor(readonly filePath: string) {}

  load(): Promise<SiteRuntimeState[]> {
    return this.queue.run(async () => {
      const raw = await readJsonFile(this.filePath);
      if (raw === undefined) return [];
      const file = raw as Partial<SitesFile>;
      if (typeof raw !== "object" || raw === null || file.version !== 1 || !Array.isArray(file.sites)) {
        throw new Error(`unsupported site state file ${this.filePath}`);
      }
      const seen = new Set<string>();
      const out: SiteRuntimeState[] = [];
      for (const entry of file.sites) {
        const parsed = parseSiteRuntimeState(entry);
        if (parsed === null || seen.has(parsed.key)) continue;
        seen.add(parsed.key);
        out.push(parsed);
      }
      return out;
    });
  }

  save(sites: readonly SiteRuntimeState[]): Promise<void> {
    const file: SitesFile = {
      version: 1,
      sites: [...sites].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).map((s) => ({ ...s })),
    };
    return this.queue.run(() => writeJsonAtomic(this.filePath, file));
  }
}
