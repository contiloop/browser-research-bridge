/** Argument parsing for `npm run site:validate` (kept apart from the CLI entry for tests). */
import { isValidSiteKey } from "../../core/site-key.js";

export interface CliArgs {
  key: string | null;
  staging: boolean;
  light: boolean;
  json: boolean;
  verbose: boolean;
  help: boolean;
  account: string | null;
  error: string | null;
}

export function parseCliArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {
    key: null,
    staging: false,
    light: false,
    json: false,
    verbose: false,
    help: false,
    account: null,
    error: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "-h" || a === "--help") args.help = true;
    else if (a === "--staging") args.staging = true;
    else if (a === "--light") args.light = true;
    else if (a === "--json") args.json = true;
    else if (a === "--verbose") args.verbose = true;
    else if (a === "--account") {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("-")) args.error = "--account needs a value";
      else args.account = v;
      i++;
    } else if (a.startsWith("-")) args.error = `unknown option ${a}`;
    else if (args.key === null) args.key = a;
    else args.error = `unexpected argument ${a}`;
  }
  if (!args.help && args.error === null && args.key === null) args.error = "missing <key>";
  if (args.key !== null && !isValidSiteKey(args.key))
    args.error = `invalid site key "${args.key}" (expected [a-z0-9-]{2,32})`;
  if (args.staging && args.light)
    args.error = "--light validates the live adapter; it cannot be combined with --staging";
  return args;
}
