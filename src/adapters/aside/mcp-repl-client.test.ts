import { EventEmitter } from "node:events";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { McpReplClient } from "./mcp-repl-client.js";
import type { SpawnedTransport } from "./mcp-repl-client.js";

type ToolHandler = (
  args: { title: string; code: string },
  child: FakeChild,
) => Promise<{ text: string; isError?: boolean }>;

/** In-memory stand-in for one `aside mcp` child: answers the MCP handshake and `repl` tool calls. */
class FakeChild implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  readonly stderr = new EventEmitter();
  readonly calls: string[] = [];
  closed = false;
  initialized = false;

  constructor(
    readonly id: number,
    private readonly handler: ToolHandler,
  ) {}

  async start(): Promise<void> {}

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) throw new Error("child is gone");
    const msg = message as { id?: number | string; method?: string; params?: Record<string, unknown> };
    if (msg.method === "initialize") {
      this.reply(msg.id!, {
        protocolVersion: msg.params?.["protocolVersion"],
        capabilities: { tools: {} },
        serverInfo: { name: "aside", version: "test" },
      });
    } else if (msg.method === "notifications/initialized") {
      this.initialized = true;
    } else if (msg.method === "tools/call") {
      const args = msg.params?.["arguments"] as { title: string; code: string };
      this.calls.push(args.code);
      void this.handler(args, this).then(
        (r) =>
          this.reply(msg.id!, { content: [{ type: "text", text: r.text }], isError: r.isError ?? false }),
        () => undefined,
      );
    } else if (msg.id !== undefined) {
      this.reply(msg.id, {});
    }
  }

  async close(): Promise<void> {
    this.die();
  }

  die(): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }

  private reply(id: number | string, result: unknown): void {
    setTimeout(() => {
      if (!this.closed) this.onmessage?.({ jsonrpc: "2.0", id, result } as JSONRPCMessage);
    }, 0);
  }
}

function harness(handler: ToolHandler, opts: { failSpawns?: number; stderrOnSpawn?: string } = {}) {
  const children: FakeChild[] = [];
  let failures = opts.failSpawns ?? 0;
  let clock = 1_000_000;
  const factory = (): SpawnedTransport => {
    if (failures > 0) {
      failures -= 1;
      const dead = new FakeChild(-1, handler);
      dead.start = async () => {
        setTimeout(() => {
          if (opts.stderrOnSpawn) dead.stderr.emit("data", opts.stderrOnSpawn);
          dead.die();
        }, 0);
      };
      dead.send = async () => undefined;
      return { transport: dead, stderr: dead.stderr as unknown as NodeJS.ReadableStream };
    }
    const child = new FakeChild(children.length + 1, handler);
    children.push(child);
    return { transport: child, stderr: child.stderr as unknown as NodeJS.ReadableStream };
  };
  const client = new McpReplClient({
    account: "u0",
    transportFactory: factory,
    now: () => clock,
    idleResetMs: 1_800_000,
    idleMarginMs: 60_000,
    handshakeTimeoutMs: 2000,
  });
  return {
    client,
    children,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const echo: ToolHandler = async (args) => ({ text: `ran:${args.code}` });

describe("McpReplClient", () => {
  it("performs the MCP handshake once and reuses the child for later calls", async () => {
    const h = harness(echo);
    expect(h.client.generation()).toBe(0);
    const r1 = await h.client.call({ title: "t", code: "1", timeoutMs: 5000 });
    const r2 = await h.client.call({ title: "t", code: "2", timeoutMs: 5000 });
    expect(r1).toEqual({ text: "ran:1", isError: false, generation: 1 });
    expect(r2.text).toBe("ran:2");
    expect(h.children).toHaveLength(1);
    expect(h.children[0]!.initialized).toBe(true);
    await h.client.close();
    expect(h.children[0]!.closed).toBe(true);
  });

  it("runs concurrent calls over the one child", async () => {
    const h = harness(async (args) => {
      await new Promise((r) => setTimeout(r, 20));
      return { text: args.code };
    });
    const results = await Promise.all(
      ["a", "b", "c"].map((code) => h.client.call({ title: "t", code, timeoutMs: 5000 })),
    );
    expect(results.map((r) => r.text)).toEqual(["a", "b", "c"]);
    expect(h.children).toHaveLength(1);
    await h.client.close();
  });

  it("restarts a dead child once and re-runs the call", async () => {
    const h = harness(async (args, child) => {
      if (child.id === 1) {
        child.die();
        return new Promise(() => undefined);
      }
      return { text: `ok:${args.code}` };
    });
    const r = await h.client.call({ title: "t", code: "x", timeoutMs: 5000 });
    expect(r).toEqual({ text: "ok:x", isError: false, generation: 2 });
    expect(h.children).toHaveLength(2);
    await h.client.close();
  });

  it("restarts the child when the REPL reports a lost browser session, then re-runs the call", async () => {
    const h = harness(async (args, child) => {
      if (child.id === 1) return { text: "Error: Session with given id not found.", isError: true };
      return { text: `ok:${args.code}` };
    });
    const r = await h.client.call({ title: "t", code: "x", timeoutMs: 5000 });
    expect(r).toEqual({ text: "ok:x", isError: false, generation: 2 });
    expect(h.children).toHaveLength(2);
    await h.client.close();
  });

  it("reports browser_unavailable when the browser session is still lost after a restart", async () => {
    const h = harness(async () => ({
      text: '{"error":"Chrome extension not connected for the requested browser profile"}',
      isError: true,
    }));
    await expect(h.client.call({ title: "t", code: "x", timeoutMs: 5000 })).rejects.toMatchObject({
      status: "browser_unavailable",
    });
    expect(h.children).toHaveLength(2);
    await h.client.close();
  });

  it("gives up with browser_unavailable when the restarted child dies too", async () => {
    const h = harness(async (_args, child) => {
      child.die();
      return new Promise(() => undefined);
    });
    await expect(h.client.call({ title: "t", code: "x", timeoutMs: 5000 })).rejects.toMatchObject({
      status: "browser_unavailable",
    });
    expect(h.children).toHaveLength(2);
    await h.client.close();
  });

  it("does not re-run a tab-bound call after a restart; it reports the lost tab", async () => {
    const h = harness(async (args, child) => {
      if (child.id === 1 && args.code === "bound") {
        child.die();
        return new Promise(() => undefined);
      }
      return { text: args.code };
    });
    const gen = await h.client.ensureReady();
    await expect(
      h.client.call({ title: "t", code: "bound", timeoutMs: 5000, generation: gen }),
    ).rejects.toMatchObject({
      status: "browser_unavailable",
      message: expect.stringContaining("restarted") as string,
    });
    // The next unbound call restarts the child transparently.
    await expect(h.client.call({ title: "t", code: "free", timeoutMs: 5000 })).resolves.toMatchObject({
      generation: 2,
    });
    // A call bound to the old generation is refused without running.
    await expect(
      h.client.call({ title: "t", code: "bound2", timeoutMs: 5000, generation: gen }),
    ).rejects.toMatchObject({
      status: "browser_unavailable",
    });
    expect(h.children[1]!.calls).toEqual(["free"]);
    await h.client.close();
  });

  it("re-handshakes with a fresh child after the 30-minute idle reset", async () => {
    const h = harness(echo);
    await h.client.call({ title: "t", code: "1", timeoutMs: 5000 });
    h.advance(10 * 60_000);
    await h.client.call({ title: "t", code: "2", timeoutMs: 5000 });
    expect(h.children).toHaveLength(1);
    h.advance(29 * 60_000); // past the reset minus the safety margin
    const r = await h.client.call({ title: "t", code: "3", timeoutMs: 5000 });
    expect(r.generation).toBe(2);
    expect(h.children).toHaveLength(2);
    expect(h.children[0]!.closed).toBe(true);
    expect(h.children[1]!.initialized).toBe(true);
    await h.client.close();
  });

  it("retries a failed start once, then reports browser_unavailable", async () => {
    const ok = harness(echo, { failSpawns: 1 });
    await expect(ok.client.call({ title: "t", code: "1", timeoutMs: 5000 })).resolves.toMatchObject({
      text: "ran:1",
    });
    await ok.client.close();

    const bad = harness(echo, { failSpawns: 5 });
    await expect(bad.client.call({ title: "t", code: "1", timeoutMs: 5000 })).rejects.toMatchObject({
      status: "browser_unavailable",
    });
    await bad.client.close();
  });

  it("maps an expired Aside CLI login to browser_unavailable with action `aside login`", async () => {
    const h = harness(echo, {
      failSpawns: 5,
      stderrOnSpawn: "Error: not logged in. Run `aside login` first.\n",
    });
    await expect(h.client.call({ title: "t", code: "1", timeoutMs: 5000 })).rejects.toMatchObject({
      status: "browser_unavailable",
      action: "run `aside login`",
    });
    await h.client.close();
  });

  it("maps a call that exceeds its time to timeout", async () => {
    const h = harness(async () => new Promise(() => undefined));
    await expect(h.client.call({ title: "t", code: "slow", timeoutMs: 50 })).rejects.toMatchObject({
      status: "timeout",
    });
    await h.client.close();
  });

  it("maps an aborted call to timeout", async () => {
    const h = harness(async () => new Promise(() => undefined));
    const ac = new AbortController();
    const p = h.client.call({ title: "t", code: "slow", timeoutMs: 5000, signal: ac.signal });
    setTimeout(() => ac.abort(), 10);
    await expect(p).rejects.toMatchObject({ status: "timeout" });
    await h.client.close();
  });

  it("refuses calls after close", async () => {
    const h = harness(echo);
    await h.client.close();
    await expect(h.client.call({ title: "t", code: "1", timeoutMs: 5000 })).rejects.toMatchObject({
      status: "browser_unavailable",
    });
  });
});
