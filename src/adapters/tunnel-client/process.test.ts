import { describe, expect, it } from "vitest";
import { nodeProcessRunner } from "./process.js";

const env = { PATH: process.env["PATH"] ?? "" };

describe("nodeProcessRunner", () => {
  it("exec returns code and output, and not_found for a missing executable", async () => {
    const ok = await nodeProcessRunner.exec(
      process.execPath,
      ["-e", "console.log('v1.2.3'); process.exit(3)"],
      {
        env,
        timeoutMs: 10_000,
      },
    );
    expect(ok).toMatchObject({ code: 3, stdout: "v1.2.3\n" });
    const missing = await nodeProcessRunner.exec("/nonexistent/tunnel-client", ["--version"], {
      env,
      timeoutMs: 1000,
    });
    expect(missing.failure).toBe("not_found");
  });

  it("spawn delivers lines and one exit, and reports a launch failure", async () => {
    const child = nodeProcessRunner.spawn(
      process.execPath,
      ["-e", "console.log('a'); console.error('b'); setTimeout(()=>{}, 60000)"],
      {
        env,
      },
    );
    const lines: string[] = [];
    child.onLine((l) => lines.push(l));
    const exited = new Promise<[number | null, string | null]>((r) => child.onExit((c, s) => r([c, s])));
    await new Promise((r) => setTimeout(r, 300));
    child.kill("SIGTERM");
    expect(await exited).toEqual([null, "SIGTERM"]);
    expect(lines.sort()).toEqual(["a", "b"]);

    const missing = nodeProcessRunner.spawn("/nonexistent/tunnel-client", ["run"], { env });
    const result = await new Promise<string | undefined>((r) => missing.onExit((_c, _s, e) => r(e)));
    expect(result).toBe("not_found");
  });
});
