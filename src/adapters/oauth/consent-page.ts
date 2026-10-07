/**
 * Server-rendered consent page: client name, redirect host, one passphrase field. The page cannot
 * know the reader's language, so every piece of wording shows Korean and English together; the
 * fields, the form, and the decision values are the same as before.
 */

export interface ConsentPageInput {
  clientName: string | null;
  clientId: string;
  redirectHost: string;
  /** Authorization request parameters echoed as hidden fields; re-validated on POST. */
  params: Record<string, string>;
  error?: string;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const STYLE = `body{font:16px/1.5 system-ui,sans-serif;max-width:28rem;margin:3rem auto;padding:0 1rem;color:#1a1a1a;background:#fafafa}
@media (prefers-color-scheme:dark){body{color:#eee;background:#1a1a1a}input{background:#2a2a2a;color:#eee}}
h1{font-size:1.3rem}dl{display:grid;grid-template-columns:auto 1fr;gap:.25rem 1rem}dt{font-weight:600}dd{margin:0;word-break:break-all}
input[type=password]{width:100%;box-sizing:border-box;padding:.5rem;font-size:1rem;margin:.5rem 0 1rem}
button{padding:.5rem 1rem;font-size:1rem;margin-right:.5rem}.err{color:#c00;font-weight:600}
.en{color:#555;font-size:.95em}@media (prefers-color-scheme:dark){.en{color:#bbb}}`;

/** Headers for every consent-page response: no caching, no framing, no referrer leakage of codes. */
export const CONSENT_HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": "no-store",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

export function renderConsentPage(input: ConsentPageInput): string {
  const hidden = Object.entries(input.params)
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join("\n");
  const name = input.clientName ?? "이름 없는 클라이언트 / Unnamed client";
  const error = input.error ? `<p class="err" role="alert">${escapeHtml(input.error)}</p>` : "";
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>연구 클라이언트 승인 / Authorize research client</title><style>${STYLE}</style></head>
<body><main>
<h1>Browser Research Bridge에 연구 클라이언트 연결<br><span class="en" lang="en">Connect a research client to your Browser Research Bridge</span></h1>
<dl><dt>클라이언트 / Client</dt><dd>${escapeHtml(name)}</dd>
<dt>돌아갈 주소 / Redirects to</dt><dd>${escapeHtml(input.redirectHost)}</dd>
<dt>클라이언트 ID / Client ID</dt><dd>${escapeHtml(input.clientId)}</dd></dl>
<p>승인하면 이 클라이언트가 Bridge를 통해 등록된 사이트를 검색하고 읽을 수 있습니다.<br>
<span class="en" lang="en">Approving lets this client search and read your registered sites through the bridge.</span></p>
${error}
<form method="post" action="/oauth/authorize">
${hidden}
<label for="passphrase">접속 암호 / Bridge passphrase</label>
<input id="passphrase" name="passphrase" type="password" autocomplete="current-password" required autofocus>
<button type="submit" name="decision" value="approve">승인 / Approve</button>
<button type="submit" name="decision" value="deny" formnovalidate>거부 / Deny</button>
</form>
</main></body></html>`;
}

export function renderMessagePage(title: string, message: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main></body></html>`;
}
