/** OAuth protocol error with its RFC 6749 / 7591 error code and HTTP status. */
export class OAuthError extends Error {
  override name = "OAuthError";

  constructor(
    readonly code: string,
    readonly description: string,
    readonly status = 400,
  ) {
    super(description);
  }

  toJSON(): { error: string; error_description: string } {
    return { error: this.code, error_description: this.description };
  }
}
