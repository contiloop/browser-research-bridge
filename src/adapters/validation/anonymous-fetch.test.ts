import { describe, expect, it } from "vitest";
import { createAnonymousFetcher } from "./anonymous-fetch.js";

function fakeFetch(routes: Record<string, { status: number; location?: string; body?: string }>) {
  const seen: { url: string; credentials: string | undefined }[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
    seen.push({ url, credentials: init?.credentials });
    const r = routes[url] ?? { status: 404, body: "not found" };
    const headers = new Headers(r.location ? { location: r.location } : {});
    return new Response(r.body ?? "", { status: r.status, headers });
  }) as typeof fetch;
  return { impl, seen };
}

describe("anonymous fetch (logged-out form for validation step d)", () => {
  it("fetches without credentials and follows redirects within the site's hosts", async () => {
    const { impl, seen } = fakeFetch({
      "https://news.example.com/premium/1": {
        status: 302,
        location: "https://www.news.example.com/premium/1?r=1",
      },
      "https://www.news.example.com/premium/1?r=1": { status: 200, body: "<p>Subscribe to continue</p>" },
    });
    const page = await createAnonymousFetcher({ fetchImpl: impl })("https://news.example.com/premium/1", [
      "news.example.com",
    ]);
    expect(page).toEqual({
      url: "https://www.news.example.com/premium/1?r=1",
      httpStatus: 200,
      html: "<p>Subscribe to continue</p>",
    });
    expect(seen.every((s) => s.credentials === "omit")).toBe(true);
  });

  it("returns a redirect that leaves the site's hosts instead of following it", async () => {
    const { impl, seen } = fakeFetch({
      "https://blog.example.com/post/1": {
        status: 302,
        location: "https://login.elsewhere.com/?next=x",
        body: "",
      },
    });
    const page = await createAnonymousFetcher({ fetchImpl: impl })("https://blog.example.com/post/1", [
      "blog.example.com",
    ]);
    expect(page.httpStatus).toBe(302);
    expect(page.url).toBe("https://login.elsewhere.com/?next=x");
    expect(seen).toHaveLength(1);
  });

  it("refuses URLs outside the site's hosts", async () => {
    const { impl } = fakeFetch({});
    await expect(
      createAnonymousFetcher({ fetchImpl: impl })("https://evil.com/", ["blog.example.com"]),
    ).rejects.toThrow(/outside/);
  });
});
