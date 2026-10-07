/** Secret generation, hashing, and constant-time comparison for the OAuth adapter. */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Opaque, URL-safe random secret with 256 bits of entropy (tokens, codes, client secrets). */
export function randomSecret(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/**
 * Storage hash of a high-entropy secret. A fast hash is sufficient because every hashed value is
 * itself 256 bits of randomness; the raw value is never persisted.
 */
export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/** Constant-time string equality (compares digests so lengths never leak). */
export function safeEqual(a: string, b: string): boolean {
  const da = createHash("sha256").update(a, "utf8").digest();
  const db = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(da, db);
}

const VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

export function isValidCodeChallenge(challenge: string): boolean {
  return CHALLENGE.test(challenge);
}

/** RFC 7636 S256: BASE64URL(SHA256(ASCII(code_verifier))) == code_challenge. */
export function verifyPkceS256(verifier: string, challenge: string): boolean {
  if (!VERIFIER.test(verifier)) return false;
  const computed = createHash("sha256").update(verifier, "ascii").digest("base64url");
  return safeEqual(computed, challenge);
}
