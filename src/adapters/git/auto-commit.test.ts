import { execFileSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDir, silentLogger } from "../../../test/support/site-fixtures.js";
import { GitSiteCommitter } from "./auto-commit.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

describe("GitSiteCommitter (temp git repository)", () => {
  let tmp: { dir: string; cleanup: () => Promise<void> };
  let repo: string;
  let sitesDir: string;

  beforeEach(async () => {
    tmp = await makeTempDir();
    repo = tmp.dir;
    sitesDir = join(repo, "sites");
    git(repo, "init", "--quiet", "--initial-branch=main");
    git(repo, "config", "user.name", "Bridge Test");
    git(repo, "config", "user.email", "bridge@example.invalid");
    git(repo, "config", "commit.gpgsign", "false");
    await writeFile(join(repo, ".gitignore"), "data\nsites/*/.staging\nsites/*/.previous\n");
    await writeFile(join(repo, "README.md"), "root\n");
    git(repo, "add", "-A");
    git(repo, "commit", "--quiet", "-m", "init");
    await mkdir(join(sitesDir, "alpha", ".staging"), { recursive: true });
    await mkdir(join(sitesDir, "alpha", ".previous"), { recursive: true });
    await mkdir(join(sitesDir, "beta"), { recursive: true });
    await writeFile(join(sitesDir, "alpha", "adapter.ts"), "export default {};\n");
    await writeFile(join(sitesDir, "alpha", "manifest.json"), "{}\n");
    await writeFile(join(sitesDir, "alpha", ".staging", "adapter.ts"), "staged\n");
    await writeFile(join(sitesDir, "alpha", ".previous", "adapter.ts"), "old\n");
    await writeFile(join(sitesDir, "beta", "adapter.ts"), "beta\n");
    await writeFile(join(repo, "README.md"), "changed\n");
    await mkdir(join(repo, "data"), { recursive: true });
    await writeFile(join(repo, "data", "sites.json"), "{}\n");
  });
  afterEach(async () => tmp.cleanup());

  it("commits only sites/<key>/ (no staging/previous, no other paths, other staged changes stay out)", async () => {
    git(repo, "add", "README.md"); // the user's own staged change must not be swept into the bridge commit
    const committer = new GitSiteCommitter({ sitesDir, enabled: true, logger: silentLogger });
    const result = await committer.commitSite("alpha", "add");
    expect(result.committed).toBe(true);
    expect(git(repo, "log", "-1", "--format=%s")).toBe("site: add alpha");
    expect(git(repo, "show", "--name-only", "--format=", "HEAD").split("\n").sort()).toEqual([
      "sites/alpha/adapter.ts",
      "sites/alpha/manifest.json",
    ]);
    expect(result.commit).toBe(git(repo, "rev-parse", "HEAD"));
    // README stays staged, beta stays untracked.
    expect(git(repo, "diff", "--cached", "--name-only")).toBe("README.md");
    expect(git(repo, "status", "--porcelain", "--", "sites/beta")).toBe("?? sites/beta/");
  });

  it("is a no-op when nothing changed or when disabled", async () => {
    const committer = new GitSiteCommitter({ sitesDir, enabled: true });
    await committer.commitSite("alpha", "add");
    const head = git(repo, "rev-parse", "HEAD");
    expect(await committer.commitSite("alpha", "repair")).toEqual({
      committed: false,
      reason: "nothing to commit",
    });
    expect(git(repo, "rev-parse", "HEAD")).toBe(head);

    await writeFile(join(sitesDir, "alpha", "adapter.ts"), "export default { v: 2 };\n");
    const disabled = new GitSiteCommitter({ sitesDir, enabled: false });
    expect(await disabled.commitSite("alpha", "repair")).toEqual({ committed: false, reason: "disabled" });
    expect(git(repo, "rev-parse", "HEAD")).toBe(head);
  });

  it("commits a removal touching only the site's folder", async () => {
    const committer = new GitSiteCommitter({ sitesDir, enabled: true });
    await committer.commitSite("alpha", "add");
    await committer.commitSite("beta", "add");
    await rm(join(sitesDir, "alpha"), { recursive: true, force: true });
    const result = await committer.commitSite("alpha", "remove");
    expect(result.committed).toBe(true);
    expect(git(repo, "log", "-1", "--format=%s")).toBe("site: remove alpha");
    expect(git(repo, "show", "--stat", "--format=", "HEAD")).toMatch(/sites\/alpha\/adapter\.ts/);
    expect(git(repo, "show", "--name-only", "--format=", "HEAD").split("\n").sort()).toEqual([
      "sites/alpha/adapter.ts",
      "sites/alpha/manifest.json",
    ]);
    expect(git(repo, "ls-files", "sites")).toBe("sites/beta/adapter.ts");
  });

  it("never adds a locally excluded site folder back (reports instead of committing)", async () => {
    await writeFile(join(repo, ".git", "info", "exclude"), "sites/beta/\n");
    const committer = new GitSiteCommitter({ sitesDir, enabled: true, logger: silentLogger });
    const head = git(repo, "rev-parse", "HEAD");
    const added = await committer.commitSite("beta", "repair");
    expect(added.committed).toBe(false);
    expect(added.reason).toMatch(/^git add failed: .*ignored/s);
    await rm(join(sitesDir, "beta"), { recursive: true, force: true });
    expect(await committer.commitSite("beta", "remove")).toEqual({
      committed: false,
      reason: "nothing to commit",
    });
    expect(git(repo, "rev-parse", "HEAD")).toBe(head);
    expect(git(repo, "ls-files", "sites")).toBe("");
  });

  it("reports (never throws) outside a git repository and for invalid keys", async () => {
    const outside = await makeTempDir();
    try {
      const committer = new GitSiteCommitter({ sitesDir: outside.dir, enabled: true });
      expect(await committer.commitSite("alpha", "add")).toEqual({
        committed: false,
        reason: "not a git repository",
      });
      expect(await committer.commitSite("../x", "add")).toMatchObject({ committed: false });
    } finally {
      await outside.cleanup();
    }
  });
});
