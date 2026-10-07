/**
 * File-backed {@link TokenStore}: one JSON file under the data dir, written atomically
 * (temp file + rename) with owner-only permissions. Holds only hashes of tokens, codes, and client
 * secrets; the OAuth adapter never hands it a raw secret. Operations are serialized in-process.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  AuthorizationCodeRecord,
  OAuthClientRecord,
  TokenRecord,
  TokenStore,
} from "../../ports/token-store.js";

interface StoreFile {
  version: 1;
  clients: OAuthClientRecord[];
  codes: AuthorizationCodeRecord[];
  tokens: TokenRecord[];
}

interface State {
  clients: Map<string, OAuthClientRecord>;
  codes: Map<string, AuthorizationCodeRecord>;
  tokens: Map<string, TokenRecord>;
}

/** Default location of the store inside the data dir. */
export function tokenStorePath(dataDir: string): string {
  return join(dataDir, "oauth", "token-store.json");
}

export class FileTokenStore implements TokenStore {
  private state: State | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  putClient(client: OAuthClientRecord): Promise<void> {
    return this.mutate((s) => {
      s.clients.set(client.clientId, structuredClone(client));
    });
  }

  markTokenIssued(clientId: string, at: Date): Promise<void> {
    return this.mutate((s) => {
      const client = s.clients.get(clientId);
      if (client) client.lastTokenIssuedAt = at.toISOString();
    });
  }

  getClient(clientId: string): Promise<OAuthClientRecord | undefined> {
    return this.read((s) => clone(s.clients.get(clientId)));
  }

  listClients(): Promise<OAuthClientRecord[]> {
    return this.read((s) => [...s.clients.values()].map((c) => structuredClone(c)));
  }

  deleteClient(clientId: string): Promise<void> {
    return this.mutate((s) => {
      s.clients.delete(clientId);
      for (const [k, code] of s.codes) if (code.clientId === clientId) s.codes.delete(k);
      for (const [k, token] of s.tokens) if (token.clientId === clientId) s.tokens.delete(k);
    });
  }

  putAuthorizationCode(code: AuthorizationCodeRecord): Promise<void> {
    return this.mutate((s) => {
      s.codes.set(code.codeHash, structuredClone(code));
    });
  }

  takeAuthorizationCode(codeHash: string): Promise<AuthorizationCodeRecord | undefined> {
    return this.mutate((s) => {
      const code = s.codes.get(codeHash);
      if (code) s.codes.delete(codeHash);
      return code;
    });
  }

  putToken(token: TokenRecord): Promise<void> {
    return this.mutate((s) => {
      s.tokens.set(token.tokenHash, structuredClone(token));
    });
  }

  getToken(tokenHash: string): Promise<TokenRecord | undefined> {
    return this.read((s) => clone(s.tokens.get(tokenHash)));
  }

  listTokens(): Promise<TokenRecord[]> {
    return this.read((s) => [...s.tokens.values()].map((t) => structuredClone(t)));
  }

  revokeToken(tokenHash: string, at: Date): Promise<boolean> {
    return this.mutate((s) => {
      const token = s.tokens.get(tokenHash);
      if (!token || token.revokedAt !== null) return false;
      token.revokedAt = at.toISOString();
      return true;
    });
  }

  revokeFamily(familyId: string, at: Date): Promise<void> {
    return this.mutate((s) => {
      for (const token of s.tokens.values()) {
        if (token.familyId === familyId && token.revokedAt === null) token.revokedAt = at.toISOString();
      }
    });
  }

  revokeClientTokens(clientId: string, at: Date): Promise<void> {
    return this.mutate((s) => {
      for (const token of s.tokens.values()) {
        if (token.clientId === clientId && token.revokedAt === null) token.revokedAt = at.toISOString();
      }
    });
  }

  purgeExpired(now: Date): Promise<number> {
    return this.mutate((s) => {
      const t = now.getTime();
      let removed = 0;
      for (const [k, code] of s.codes) {
        if (Date.parse(code.expiresAt) <= t) {
          s.codes.delete(k);
          removed++;
        }
      }
      for (const [k, token] of s.tokens) {
        if (Date.parse(token.expiresAt) <= t) {
          s.tokens.delete(k);
          removed++;
        }
      }
      return removed;
    });
  }

  private read<T>(fn: (s: State) => T): Promise<T> {
    return this.enqueue(async () => fn(await this.load()));
  }

  private mutate<T>(fn: (s: State) => T): Promise<T> {
    return this.enqueue(async () => {
      const state = await this.load();
      const result = fn(state);
      await this.persist(state);
      return result;
    });
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async load(): Promise<State> {
    if (this.state) return this.state;
    let file: StoreFile = { version: 1, clients: [], codes: [], tokens: [] };
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<StoreFile>;
      if (parsed.version !== 1) throw new Error(`unsupported token store version ${String(parsed.version)}`);
      file = {
        version: 1,
        clients: parsed.clients ?? [],
        codes: parsed.codes ?? [],
        tokens: parsed.tokens ?? [],
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`cannot load token store ${this.filePath}: ${(error as Error).message}`, {
          cause: error,
        });
      }
    }
    this.state = {
      clients: new Map(file.clients.map((c) => [c.clientId, c])),
      codes: new Map(file.codes.map((c) => [c.codeHash, c])),
      tokens: new Map(file.tokens.map((t) => [t.tokenHash, t])),
    };
    return this.state;
  }

  private async persist(state: State): Promise<void> {
    const file: StoreFile = {
      version: 1,
      clients: [...state.clients.values()],
      codes: [...state.codes.values()],
      tokens: [...state.tokens.values()],
    };
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, this.filePath);
  }
}

function clone<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : structuredClone(value);
}
