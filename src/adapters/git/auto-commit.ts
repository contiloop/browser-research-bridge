/**
 * Git auto-commit of one site folder (config `git.autoCommit`). After a successful
 * onboarding, repair, or removal the bridge commits only `sites/<key>/` with the message
 * `site: add|repair|remove <key>`. Nothing else is ever staged or committed: the pathspec limits both
 * `git add` and `git commit` (other staged changes stay staged and are not included). `.staging/`
 * and `.previous/` are git-ignored. Commit hooks are skipped (`--no-verify`) so an unrelated hook
 * cannot block or rewrite the bridge's commit. Never throws; failures come back as `reason`.
 */
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { isValidSiteKey } from "../../core/site-key.js";
import type { Logger } from "../../ports/logger.js";
import type { SiteCommitAction, SiteCommitResult, SiteCommitter } from "../../ports/site-store.js";

export interface GitSiteCommitterOptions {
  /** Absolute path of the sites directory (inside the git work tree). */
  sitesDir: string;
  /** `git.autoCommit`; false → every call is a no-op. */
  enabled: boolean;
  logger?: Logger | undefined;
  /** Git executable (default `git`). */
  gitBinary?: string | undefined;
}

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runGit(binary: string, cwd: string, args: readonly string[]): Promise<GitResult> {
  return new Promise((resolvePromise) => {
    execFile(
      binary,
      [...args],
      { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const raw: unknown = error === null ? 0 : (error as { code?: unknown }).code;
        const code = typeof raw === "number" ? raw : 127;
        resolvePromise({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

export function commitMessage(action: SiteCommitAction, key: string): string {
  return `site: ${action} ${key}`;
}

export class GitSiteCommitter implements SiteCommitter {
  private readonly sitesDir: string;
  private readonly enabled: boolean;
  private readonly logger: Logger | undefined;
  private readonly git: string;

  constructor(options: GitSiteCommitterOptions) {
    this.sitesDir = resolve(options.sitesDir);
    this.enabled = options.enabled;
    this.logger = options.logger;
    this.git = options.gitBinary ?? "git";
  }

  async commitSite(key: string, action: SiteCommitAction): Promise<SiteCommitResult> {
    if (!this.enabled) return { committed: false, reason: "disabled" };
    if (!isValidSiteKey(key)) return { committed: false, reason: `invalid site key: ${key}` };
    try {
      const result = await this.commit(key, action);
      if (result.committed) {
        this.logger?.info("site folder committed", { site: key, action, commit: result.commit ?? null });
      } else if (result.reason !== "nothing to commit") {
        this.logger?.warn("site folder not committed", { site: key, action, reason: result.reason ?? null });
      }
      return result;
    } catch (error) {
      const reason = (error as Error).message;
      this.logger?.warn("site folder not committed", { site: key, action, reason });
      return { committed: false, reason };
    }
  }

  private async commit(key: string, action: SiteCommitAction): Promise<SiteCommitResult> {
    const top = await runGit(this.git, this.sitesDir, ["rev-parse", "--show-toplevel"]);
    if (top.code !== 0) return { committed: false, reason: "not a git repository" };
    const root = await realpath(top.stdout.trim());
    const sitesReal = await realpath(this.sitesDir);
    const rel = relative(root, `${sitesReal}${sep}${key}`).split(sep).join("/");
    if (rel === "" || rel.startsWith("..")) {
      return { committed: false, reason: "the sites directory is outside the git work tree" };
    }
    const pathspec = `:(literal)${rel}`;

    const add = await runGit(this.git, root, ["add", "--all", "--", pathspec]);
    if (add.code !== 0 && !/did not match any files/.test(add.stderr)) {
      return { committed: false, reason: `git add failed: ${add.stderr.trim()}` };
    }
    const diff = await runGit(this.git, root, ["diff", "--cached", "--quiet", "--", pathspec]);
    if (diff.code === 0) return { committed: false, reason: "nothing to commit" };
    if (diff.code !== 1) return { committed: false, reason: `git diff failed: ${diff.stderr.trim()}` };

    const commit = await runGit(this.git, root, [
      "commit",
      "--no-verify",
      "--quiet",
      "-m",
      commitMessage(action, key),
      "--",
      pathspec,
    ]);
    if (commit.code !== 0) {
      return { committed: false, reason: `git commit failed: ${(commit.stderr || commit.stdout).trim()}` };
    }
    const head = await runGit(this.git, root, ["rev-parse", "HEAD"]);
    return { committed: true, commit: head.stdout.trim() };
  }
}
