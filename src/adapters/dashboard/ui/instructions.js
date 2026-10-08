/* Fixed addresses, terminal commands, and the instruction texts for the Aside AI (the AI built into
 * the Aside browser). A plain ES module with no DOM access, so the page and the unit tests import the
 * same texts.
 *
 * Rules the texts follow (checked by tests): the AI stops before the runtime key is created and
 * before the connector is submitted; it never asks for, reads, or types a key or the passphrase and
 * never acts on the consent page; it does not open or operate the program's local settings page.
 * The login text asks the AI to log the user in with the password already saved in the Aside
 * browser, to stop and tell the user when no password is saved or a code is asked for, and never to
 * ask the user for a password. The texts hold no secret and no settings-page address. The only
 * values put into a text are the tunnel id (not a secret) and a site's login address, both checked
 * for their form first. */
/* global URL */

/** Canonical setup URLs from `tunnel-client --help`, and the official install guide (src/adapters/tunnel-client/AGENTS.md). */
export const LINKS = {
  tunnels: "https://platform.openai.com/settings/organization/tunnels",
  apiKeys: "https://platform.openai.com/settings/organization/api-keys",
  connectors: "https://chatgpt.com/#settings/Connectors",
  installGuide: "https://developers.openai.com/api/docs/guides/secure-mcp-tunnels",
};

/** Terminal commands the page shows with a copy button (only where one cannot be avoided). */
export const COMMANDS = {
  asideLogin: "aside login",
  installTunnelClient: "brew install openai/tools/tunnel-client",
};

const TUNNEL_PLACEHOLDER = { en: "the tunnel I just created", ko: "방금 만든 터널" };

const TEXTS = {
  en: {
    tunnel: [
      "Please help me with one task on the OpenAI platform website. Follow these rules exactly:",
      "- Do not open or operate the program's local settings page (the Browser Research Bridge settings page on this computer). Stay on the OpenAI pages named below.",
      "- Never create, read, copy, or write down an API key, a runtime key, or a passphrase, and never ask me for one.",
      "- If you are asked to sign in, stop and ask me to sign in myself.",
      "- The buttons and labels on the site may be worded differently from these instructions.",
      "",
      "Steps:",
      `1. Open ${LINKS.tunnels}`,
      '2. Create a new tunnel. Name it "Browser Research Bridge".',
      "3. Tell me the tunnel id of the new tunnel. It starts with tunnel_ followed by 32 letters and digits.",
      `4. Open ${LINKS.apiKeys} and open the form for creating a new key that I will use for this tunnel. It needs the permission Tunnels: Read and Use.`,
      '5. Stop before creating the key. Do not press the button that creates the key. Tell me: "Please create the key yourself, copy it yourself, and paste it into the settings page together with the tunnel id."',
    ].join("\n"),
    connector: [
      "Please help me with one task in ChatGPT's settings. Follow these rules exactly:",
      "- Do not open or operate the program's local settings page (the Browser Research Bridge settings page on this computer). Stay on the ChatGPT pages named below.",
      "- Never ask for, read, or type a passphrase or a key.",
      "- Do not act on the approval page that asks for a passphrase. Leave it to me.",
      "- If you are asked to sign in, stop and ask me to sign in myself.",
      "- The buttons and labels on the site may be worded differently from these instructions.",
      "",
      "Steps:",
      `1. Open ${LINKS.connectors}`,
      "2. Under the advanced settings, turn on developer mode.",
      "3. Start creating a new connector and fill in the form:",
      '   - Name: "Browser Research Bridge"',
      "   - Connection: use the tunnel {tunnel} (not a public address)",
      "   - Authentication: OAuth",
      '4. Stop before submitting the form. Do not press the button that creates or saves the connector. Tell me: "Please check the form, submit it yourself, and enter the passphrase yourself on the page that opens."',
    ].join("\n"),
  },
  ko: {
    tunnel: [
      "OpenAI 플랫폼 웹사이트에서 한 가지 작업을 도와주세요. 아래 규칙을 정확히 지켜 주세요.",
      "- 이 프로그램의 로컬 설정 페이지(이 컴퓨터의 Browser Research Bridge 설정 페이지)는 열지도, 조작하지도 마세요. 아래에 적힌 OpenAI 페이지에서만 작업하세요.",
      "- API 키, 런타임 키, 암호를 만들거나 읽거나 복사하거나 받아 적지 마세요. 저에게 물어보지도 마세요.",
      "- 로그인을 요구하면 멈추고, 제가 직접 로그인하도록 알려 주세요.",
      "- 사이트의 버튼과 이름은 이 안내와 다르게 적혀 있을 수 있습니다.",
      "",
      "순서:",
      `1. ${LINKS.tunnels} 를 여세요.`,
      '2. 새 터널을 만드세요. 이름은 "Browser Research Bridge"로 하세요.',
      "3. 새 터널의 터널 ID를 저에게 알려 주세요. tunnel_ 뒤에 영문자와 숫자 32자가 붙은 형태입니다.",
      `4. ${LINKS.apiKeys} 를 열고, 이 터널에 쓸 새 키를 만드는 입력 창을 여세요. 필요한 권한은 Tunnels: Read 와 Use 입니다.`,
      '5. 키를 만들기 직전에 멈추세요. 키를 만드는 버튼은 누르지 마세요. 저에게 "키는 직접 만들고 직접 복사한 뒤, 터널 ID와 함께 설정 페이지에 붙여 넣으세요."라고 알려 주세요.',
    ].join("\n"),
    connector: [
      "ChatGPT 설정에서 한 가지 작업을 도와주세요. 아래 규칙을 정확히 지켜 주세요.",
      "- 이 프로그램의 로컬 설정 페이지(이 컴퓨터의 Browser Research Bridge 설정 페이지)는 열지도, 조작하지도 마세요. 아래에 적힌 ChatGPT 페이지에서만 작업하세요.",
      "- 암호나 키를 묻거나 읽거나 입력하지 마세요.",
      "- 암호를 묻는 승인 페이지에서는 아무것도 하지 마세요. 저에게 맡기세요.",
      "- 로그인을 요구하면 멈추고, 제가 직접 로그인하도록 알려 주세요.",
      "- 사이트의 버튼과 이름은 이 안내와 다르게 적혀 있을 수 있습니다.",
      "",
      "순서:",
      `1. ${LINKS.connectors} 를 여세요.`,
      "2. 고급 설정에서 개발자 모드를 켜세요.",
      "3. 새 커넥터 만들기를 시작하고 입력 칸을 채우세요.",
      '   - 이름: "Browser Research Bridge"',
      "   - 연결 방식: 터널 {tunnel} 사용 (공개 주소가 아님)",
      "   - 인증: OAuth",
      '4. 제출하기 직전에 멈추세요. 커넥터를 만들거나 저장하는 버튼은 누르지 마세요. 저에게 "내용을 확인한 뒤 직접 제출하고, 열리는 페이지에서 암호를 직접 입력하세요."라고 알려 주세요.',
    ].join("\n"),
  },
};

/* The login text: `{step1}` becomes the first step, which names the site's login address. */
const LOGIN_TEXTS = {
  en: {
    text: [
      "Please help me log in to one website in this browser. Follow these rules exactly:",
      "- Do not open or operate the program's local settings page (the Browser Research Bridge settings page on this computer). Stay on the website named below.",
      "- Use only the password that is already saved in this browser for this site. Never ask me for a password or a code.",
      "- If no password is saved for this site, stop and tell me.",
      "- If the site asks for a code (for example one sent by text message or email, or one from an authenticator app), stop and tell me.",
      "- The buttons and labels on the site may be worded differently from these instructions.",
      "",
      "Steps:",
      "{step1}",
      "2. Log in with the password saved in this browser for this site.",
      "3. When the site shows that I am logged in, stop and tell me.",
    ].join("\n"),
    url: "1. Open {address}",
    host: "1. Open https://{address}/ and go to the site's login page.",
  },
  ko: {
    text: [
      "이 브라우저에서 웹사이트 한 곳에 로그인하도록 도와주세요. 아래 규칙을 정확히 지켜 주세요.",
      "- 이 프로그램의 로컬 설정 페이지(이 컴퓨터의 Browser Research Bridge 설정 페이지)는 열지도, 조작하지도 마세요. 아래에 적힌 웹사이트에서만 작업하세요.",
      "- 이 브라우저에 이 사이트용으로 이미 저장된 비밀번호만 쓰세요. 저에게 비밀번호나 인증 코드를 묻지 마세요.",
      "- 이 사이트에 저장된 비밀번호가 없으면 멈추고 저에게 알려 주세요.",
      "- 사이트가 인증 코드(문자나 이메일로 받는 코드, 인증 앱의 코드 등)를 요구하면 멈추고 저에게 알려 주세요.",
      "- 사이트의 버튼과 이름은 이 안내와 다르게 적혀 있을 수 있습니다.",
      "",
      "순서:",
      "{step1}",
      "2. 이 브라우저에 이 사이트용으로 저장된 비밀번호로 로그인하세요.",
      "3. 로그인된 것이 보이면 멈추고 저에게 알려 주세요.",
    ].join("\n"),
    url: "1. {address} 를 여세요.",
    host: "1. https://{address}/ 를 열고 사이트의 로그인 페이지로 가세요.",
  },
};

/** A public DNS name with at least one dot; no IP literal, `localhost`, or `.local` name. */
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;

function publicHostname(value) {
  if (typeof value !== "string") return null;
  const host = value.trim().toLowerCase().replace(/\.$/, "");
  if (!HOSTNAME.test(host)) return null;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return null;
  return host;
}

function publicLoginUrl(value) {
  if (typeof value !== "string" || value.length > 500 || /\s/.test(value)) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username !== "" || url.password !== "" || url.port !== "") return null;
  if (publicHostname(url.hostname) === null) return null;
  return url.href;
}

/**
 * Where the login text sends the Aside AI: the site's `loginUrl` when it is a plain web address on a
 * public host, else the first public hostname (`hostnames`, then the host of `input` when that is a
 * web address). `{ kind: "url" | "host", address }`, or null when none qualifies (no text is offered).
 */
export function loginTarget({ loginUrl, hostnames, input } = {}) {
  const url = publicLoginUrl(loginUrl);
  if (url !== null) return { kind: "url", address: url };
  for (const name of Array.isArray(hostnames) ? hostnames : []) {
    const host = publicHostname(name);
    if (host !== null) return { kind: "host", address: host };
  }
  if (typeof input === "string") {
    try {
      const host = publicHostname(new URL(input).hostname);
      if (host !== null) return { kind: "host", address: host };
    } catch {
      // Not a web address (a site name): no login address to offer.
    }
  }
  return null;
}

/** The login text for the Aside AI in `lang` for a {@link loginTarget} result, or null without one. */
export function loginText(lang, target) {
  if (!target || (target.kind !== "url" && target.kind !== "host")) return null;
  const address = target.kind === "url" ? publicLoginUrl(target.address) : publicHostname(target.address);
  if (address === null) return null;
  const texts = LOGIN_TEXTS[lang] ?? LOGIN_TEXTS.en;
  const step1 = texts[target.kind].replace("{address}", address);
  return texts.text.replace("{step1}", step1);
}

const TUNNEL_ID = /^tunnel_[0-9a-f]{32}$/;

/**
 * The instruction text for the Aside AI: `which` is `"tunnel"` (sub-step b) or `"connector"`
 * (sub-step e). Only a well-formed tunnel id is put into the connector text.
 */
export function asideText(lang, which, options = {}) {
  const texts = TEXTS[lang] ?? TEXTS.en;
  const text = texts[which];
  if (text === undefined) throw new Error(`unknown instruction text: ${which}`);
  const tunnelId =
    typeof options.tunnelId === "string" && TUNNEL_ID.test(options.tunnelId) ? options.tunnelId : null;
  const placeholder = TUNNEL_PLACEHOLDER[lang] ?? TUNNEL_PLACEHOLDER.en;
  return text.replace("{tunnel}", tunnelId ?? placeholder);
}

export const INSTRUCTION_TEXTS = TEXTS;
