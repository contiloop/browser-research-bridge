/** Argument parsing for `npm run site:onboard` (kept apart from the CLI entry for tests). */
import { isValidSiteKey } from "../../core/site-key.js";

export type OnboardCommand =
  | { kind: "add"; input: string; note: string | null }
  | { kind: "retry"; key: string }
  | { kind: "repair"; key: string; note: string | null }
  | { kind: "sdk-check" };

export interface OnboardArgs {
  command: OnboardCommand | null;
  verbose: boolean;
  force: boolean;
  help: boolean;
  error: string | null;
}

export function parseOnboardArgs(argv: readonly string[]): OnboardArgs {
  const out: OnboardArgs = { command: null, verbose: false, force: false, help: false, error: null };
  let input: string | null = null;
  let note: string | null = null;
  let retry: string | null = null;
  let repair: string | null = null;
  let sdkCheck = false;
  const value = (i: number, flag: string): string | null => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) {
      out.error = `${flag} needs a value`;
      return null;
    }
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "-h" || a === "--help") out.help = true;
    else if (a === "--verbose") out.verbose = true;
    else if (a === "--force") out.force = true;
    else if (a === "--sdk-check") sdkCheck = true;
    else if (a === "--note") {
      note = value(i, "--note");
      i++;
    } else if (a === "--retry") {
      retry = value(i, "--retry");
      i++;
    } else if (a === "--repair") {
      repair = value(i, "--repair");
      i++;
    } else if (a.startsWith("--")) out.error = `unknown option ${a}`;
    else if (input === null) input = a;
    else input = `${input} ${a}`; // a site name may arrive unquoted ("Naver Blog")
  }
  if (out.help || out.error !== null) return out;
  const modes = [input !== null, retry !== null, repair !== null, sdkCheck].filter(Boolean).length;
  if (modes === 0) out.error = "give a URL or site name, --retry <key>, --repair <key>, or --sdk-check";
  else if (modes > 1) out.error = "give only one of: <url|name>, --retry, --repair, --sdk-check";
  else if (retry !== null) {
    if (!isValidSiteKey(retry)) out.error = `invalid site key "${retry}"`;
    else out.command = { kind: "retry", key: retry };
  } else if (repair !== null) {
    if (!isValidSiteKey(repair)) out.error = `invalid site key "${repair}"`;
    else out.command = { kind: "repair", key: repair, note };
  } else if (sdkCheck) out.command = { kind: "sdk-check" };
  else out.command = { kind: "add", input: input as string, note };
  return out;
}
