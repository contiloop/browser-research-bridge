/** Site manifest schema with built-in defaults; tunable defaults come in as options. */
import { z } from "zod";
import { DEFAULT_MIN_INTERVAL_MS, DEFAULT_MIN_READ_CHARS } from "../core/defaults.js";
import type { SiteCapabilities } from "../core/models.js";
import { SITE_KEY_PATTERN } from "../core/site-key.js";

const HOSTNAME =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

const httpUrl = z.url({ protocol: /^https?$/ });

export interface SiteManifestSchemaOptions {
  defaultMinReadChars?: number;
  defaultMinIntervalMs?: number;
}

export function createSiteManifestSchema(options: SiteManifestSchemaOptions = {}) {
  return z
    .object({
      key: z.string().regex(SITE_KEY_PATTERN, "key must match [a-z0-9-]{2,32}"),
      name: z.string().trim().min(1),
      hostnames: z
        .array(z.string().trim().toLowerCase().regex(HOSTNAME, "invalid hostname"))
        .min(1)
        .refine((hs) => new Set(hs).size === hs.length, "hostnames must be unique"),
      /**
       * Extra hosts the browser session may navigate to or request (login/SSO, CDN, data APIs), e.g.
       * `nid.naver.com`. Navigation/request allowlist only: ownership (URL → site resolution, duplicate
       * checks) uses `hostnames` alone. A host also covers its subdomains.
       */
      extraAllowedHosts: z
        .array(z.string().trim().toLowerCase().regex(HOSTNAME, "invalid hostname"))
        .default([])
        .refine((hs) => new Set(hs).size === hs.length, "extraAllowedHosts must be unique"),
      loginUrl: httpUrl.nullable().default(null),
      requiresLogin: z.boolean().default(false),
      timezone: z.string().refine(isValidTimeZone, "unknown IANA time zone"),
      capabilities: z.object({
        search: z.boolean(),
        read: z.boolean(),
        dateFilter: z.boolean().default(false),
        pagination: z.boolean().default(false),
      }),
      sampleQuery: z.string().trim().default(""),
      sampleReadUrl: httpUrl.nullable().default(null),
      gatedSampleUrl: httpUrl.nullable().default(null),
      minReadChars: z
        .int()
        .min(1)
        .default(options.defaultMinReadChars ?? DEFAULT_MIN_READ_CHARS),
      minIntervalMs: z
        .int()
        .min(0)
        .default(options.defaultMinIntervalMs ?? DEFAULT_MIN_INTERVAL_MS),
      createdBy: z.enum(["agent", "human"]),
      version: z.int().min(1).default(1),
    })
    .refine((m) => !m.capabilities.search || m.sampleQuery !== "", {
      message: "sampleQuery is required when capabilities.search is true",
      path: ["sampleQuery"],
    });
}

export const siteManifestSchema = createSiteManifestSchema();

/** A parsed manifest with defaults applied. */
export type SiteManifest = z.output<typeof siteManifestSchema>;
/** Manifest as written on disk (defaults optional). */
export type SiteManifestInput = z.input<typeof siteManifestSchema>;

// Compile-time guard: the manifest's capabilities match the core model.
const _capabilitiesMatch: SiteCapabilities = {} as SiteManifest["capabilities"];
void _capabilitiesMatch;

export type ParseManifestResult = { ok: true; manifest: SiteManifest } | { ok: false; error: string };

export function parseSiteManifest(input: unknown, options?: SiteManifestSchemaOptions): ParseManifestResult {
  const schema = options ? createSiteManifestSchema(options) : siteManifestSchema;
  const result = schema.safeParse(input);
  if (result.success) return { ok: true, manifest: result.data };
  const error = result.error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`)
    .join("; ");
  return { ok: false, error };
}
