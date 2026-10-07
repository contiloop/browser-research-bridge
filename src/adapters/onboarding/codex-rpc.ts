/**
 * The JSON-RPC channel to one `codex app-server` child over its stdio pipes (newline-delimited JSON,
 * the app-server's stdio transport). The pipes are anonymous: only the bridge process and that one
 * child hold them, so nothing on the network or in a web page can reach the channel, and it ends
 * when the child's pipes close.
 */
import type { Readable, Writable } from "node:stream";

export interface RpcError {
  code: number;
  message: string;
}

export type RpcMessage = {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: RpcError;
};

/** Answer to a request the server sends to the client. */
export type ServerRequestReply = { result: unknown } | { error: RpcError };

export class RpcClosedError extends Error {
  constructor(message = "the Codex channel closed") {
    super(message);
    this.name = "RpcClosedError";
  }
}

export interface JsonRpcPeerOptions {
  input: Readable;
  output: Writable;
  onNotification(method: string, params: unknown): void;
  onRequest(method: string, params: unknown): Promise<ServerRequestReply>;
  /** A line that is not JSON (the app-server writes only JSON on stdout). */
  onGarbage?: ((length: number) => void) | undefined;
}

export class JsonRpcPeer {
  private nextId = 1;
  private buffer = "";
  private closed = false;
  private readonly pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();

  constructor(private readonly o: JsonRpcPeerOptions) {
    o.input.setEncoding("utf8");
    o.input.on("data", (chunk: string) => this.onData(chunk));
    o.input.on("close", () => this.close());
    o.input.on("end", () => this.close());
    o.output.on("error", () => this.close());
  }

  get isClosed(): boolean {
    return this.closed;
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new RpcClosedError());
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    this.write(params === undefined ? { method } : { method, params });
  }

  /** Rejects every pending request; later sends are dropped. */
  close(reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new RpcClosedError(reason));
    this.pending.clear();
  }

  private write(message: RpcMessage): void {
    try {
      this.o.output.write(`${JSON.stringify(message)}\n`);
    } catch {
      this.close();
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let i: number;
    while ((i = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, i).trim();
      this.buffer = this.buffer.slice(i + 1);
      if (line !== "") this.onLine(line);
    }
  }

  private onLine(line: string): void {
    let m: RpcMessage;
    try {
      m = JSON.parse(line) as RpcMessage;
    } catch {
      this.o.onGarbage?.(line.length);
      return;
    }
    if (typeof m !== "object" || m === null) return;
    if (m.method !== undefined && m.id !== undefined) {
      const id = m.id;
      void this.o
        .onRequest(m.method, m.params)
        .catch((e: unknown) => ({ error: { code: -32603, message: (e as Error).message } }))
        .then((reply) => this.write({ id, ...reply }));
    } else if (m.method !== undefined) {
      this.o.onNotification(m.method, m.params);
    } else if (typeof m.id === "number") {
      const p = this.pending.get(m.id);
      if (p === undefined) return;
      this.pending.delete(m.id);
      if (m.error !== undefined) p.reject(new Error(m.error.message ?? "request failed"));
      else p.resolve(m.result);
    }
  }
}
