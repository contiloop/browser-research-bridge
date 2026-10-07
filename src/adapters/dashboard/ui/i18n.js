/* Wording of the settings page in English and Korean. Both dictionaries must have the
 * same keys and the same {placeholders}; the unit tests check it. Written for a reader who does not
 * know how the program is built: every term is explained where it first appears.
 * A plain ES module with no DOM access. */

export const LANGS = ["ko", "en"];

const en = {
  "app.title": "Browser Research Bridge settings",
  "app.heading": "Browser Research Bridge",
  "app.intro":
    "You are looking at the settings page of Browser Research Bridge, the program on this Mac that lets ChatGPT search and read websites you are logged in to in the Aside browser. This settings page opens only on this Mac; nobody on the internet can reach it.",
  "app.loading": "Loading…",
  "lang.label": "Language",

  "nav.start": "Getting started",
  "nav.sites": "Sites",
  "nav.connection": "Connection",
  "nav.settings": "Settings",

  "status.program": "Program",
  "status.aside": "Aside browser",
  "status.chatgpt": "ChatGPT",
  "status.asideReady": "ready",
  "status.asideNotReady": "not reachable",
  "status.unknown": "cannot check yet",
  "status.connected": "connected",
  "status.notConnected": "not connected yet",

  "banner.setupPassphrase":
    "Only the settings page is running. ChatGPT cannot use the program until you set an access passphrase in step 1 of Getting started.",
  "banner.setupConfig":
    "Only the settings page is running, because a settings file has a mistake. Correct the setting below (or in the file) and save, or press Restart after fixing the file.",
  "banner.setupStart":
    "Only the settings page is running, because the program could not start. Press Restart to try again; the reason is under Details.",
  "banner.restarting":
    "The program is restarting to use your change. This page stays open and updates by itself in a few seconds.",
  "banner.restartSlow": "The restart is taking longer than usual. This page keeps checking.",
  "banner.restartDone": "The program is running again.",
  "banner.restartSetup": "The program did not start. {reason}",
  "banner.signedOut":
    "This settings page is no longer signed in, usually because the program was restarted completely. Double-click “Open Settings.command” in the program's folder to open it again.",

  "common.details": "Details",
  "common.copy": "Copy",
  "common.copied": "Copied.",
  "common.copyFailed": "Could not copy. Select the text and copy it by hand.",
  "common.show": "Show",
  "common.hide": "Hide",
  "common.save": "Save",
  "common.working": "Working…",
  "common.checkAgain": "Check again",
  "common.yes": "yes",
  "common.no": "no",
  "common.never": "never",
  "common.none": "none",
  "common.done": "Done",
  "common.close": "Close",
  "common.optional": "optional",

  "step.done": "Done",
  "step.todo": "To do",
  "step.unknown": "Cannot check yet",
  "step.why.need_passphrase": "Set the access passphrase first (step 1).",
  "step.why.core_off":
    "The program is not running right now, so this cannot be checked. See the message at the top of the page.",
  "step.why.restarting": "The program is restarting; this is checked again in a moment.",
  "step.why.no_data": "This could not be checked. Press Check again or reload the page.",

  "start.title": "Getting started",
  "start.intro":
    "Five steps take you from a fresh install to searching from ChatGPT. Each step checks itself, so you can come back to this list at any time.",
  "start.allDone": "Everything is set up. You can use the program from ChatGPT now.",

  "step1.title": "Set the access passphrase",
  "step1.explain":
    "The access passphrase is a long password that only you know. You type it once, when you connect ChatGPT to this program for the first time, so that nobody else can connect. It is typed on an approval page that opens in your browser, never inside a ChatGPT chat. Nothing else works until it is set.",
  "step1.done": "An access passphrase is set.",

  "step2.title": "Aside browser ready",
  "step2.explain":
    "The program opens websites in your Aside browser, where you are logged in to them. The Aside app must be open, and its command-line tool must be signed in.",
  "step2.ok": "Aside is open and reachable (account {account}).",
  "step2.notOk": "The program cannot reach Aside right now.",
  "step2.howto1": "Open the Aside app on this Mac.",
  "step2.howto2":
    "If Aside is already open, sign its command-line tool in: open the Terminal app, paste the command below, press Return, and follow what it says.",
  "step2.howto3": "Then press Check again.",

  "step3.title": "Connect ChatGPT",
  "step3.explain":
    "The program does all the work on this Mac. A few steps happen on the OpenAI and ChatGPT websites; they are written out below.",
  "step3.done": "ChatGPT is connected.",

  "step4.title": "Site-add helper ready",
  "step4.explain":
    "The helper is an AI assistant that prepares a new site for the program: it studies how the site's search and articles work and writes the small piece of code the program needs for that site. It runs on a Claude or ChatGPT subscription you already have, signed in on this Mac in the Claude Code or Codex app. No API key is needed.",
  "step4.check": "Check",
  "step4.checking": "Checking… this sends one short request to the AI and can take up to a minute.",

  "step5.title": "Sites",
  "step5.explain":
    "Sites are the websites the program searches for you. Reuters comes with the program: log in to reuters.com in Aside, then press Check now.",
  "step5.noReuters": "Reuters is not in the site list. You can add it or any other site below.",
  "step5.addMore": "To add another site, use the form under Sites.",
  "step5.goSites": "Open Sites",

  "helper.title": "Helper",
  "helper.runtime.ready": "{name}: installed and signed in",
  "helper.runtime.unknownSignIn": "{name}: installed (sign-in is confirmed by Check)",
  "helper.runtime.notSignedIn": "{name}: installed, not signed in",
  "helper.runtime.missing": "{name}: not installed",
  "helper.runtime.notShipped": "{name}: not available in this version",
  "helper.wouldUse": "A site added now would be prepared with: {runtime}.",
  "helper.noneAvailable":
    "Neither Claude Code nor Codex can be used on this Mac. Install one of them and sign in with your subscription, then press Check.",
  "helper.dataClaude": "With Claude, the pages the helper looks at are sent to Anthropic.",
  "helper.dataCodex": "With Codex, the pages the helper looks at are sent to OpenAI.",
  "helper.lastCheck": "Last check ({time}): {result}",
  "helper.noCheck": "Not checked yet since the program started.",
  "helper.off": "The helper can be checked when the program is running.",

  "sites.title": "Sites",
  "sites.addTitle": "Add a site",
  "sites.addExplain":
    "Paste the site's address and press Add. The helper then studies the site and prepares it; this takes a few minutes and uses your Claude or ChatGPT subscription.",
  "sites.input": "Site address or name",
  "sites.inputPlaceholder": "https://www.example.com",
  "sites.noteToggle": "Add a note for the helper",
  "sites.note": "Note for the helper",
  "sites.notePlaceholder": "for example: search only the blogs I follow",
  "sites.add": "Add",
  "sites.added": "Added. The helper has started; you can follow it in the site list.",
  "sites.listTitle": "Your sites",
  "sites.empty": "No sites yet.",
  "sites.off": "The site list is shown when the program is running. See the message at the top of the page.",
  "sites.offRestarting": "The program is restarting; the site list comes back in a moment.",

  "site.do.working":
    "The helper is working on this site. This takes a few minutes; you can follow it with Show progress.",
  "site.do.awaiting": "The helper needs you to do something first:",
  "site.do.awaitingThen": "When you have done it, press Retry.",
  "site.do.jobFailed": "The helper could not finish. Press Retry to try again; the reason is under Details.",
  "site.do.login": "Log in at {url} in Aside, then press Check now.",
  "site.do.loginNoUrl": "Log in to this site in Aside, then press Check now.",
  "site.do.degraded": "The site works only partly. Press Repair so the helper fixes it.",
  "site.do.failed":
    "This site does not work. Press Repair so the helper fixes it; the reason is under Details.",
  "site.do.onboarding": "The site is being prepared.",
  "site.do.fine": "Working. Nothing to do.",
  "site.do.checkFirst": "Ready. Press Check now once to confirm it works.",
  "site.do.unknown": "No action is suggested for this state.",
  "site.checking": "checking…",
  "site.lastChecked": "Last checked: {time}",
  "site.d.key": "Site key",
  "site.d.addresses": "Addresses",
  "site.d.capabilities": "Can do",
  "site.d.lastFailure": "Last problem",
  "site.d.folderProblem": "Folder problem",
  "site.d.job": "Latest helper job",
  "site.d.runtime": "Helper ran on",
  "site.d.cache": "Saved pages",
  "site.d.lastChecked": "Last checked",
  "job.d.id": "Job id",
  "job.d.attempts": "Attempts",
  "job.d.commit": "Saved version (commit)",
  "job.d.lang": "Language of the helper's messages",
  "step2.d.action": "Suggested action",

  "action.retry": "Retry",
  "action.repair": "Repair",
  "action.check": "Check now",
  "action.cancel": "Cancel job",
  "action.remove": "Remove",
  "action.showLog": "Show progress",

  "confirm.remove":
    "Remove {site}? Its folder, saved state and saved pages are deleted. This cannot be undone.",
  "prompt.repair": "Repair {site}: you can write a note for the helper (optional).",
  "check.result": "Check of {site}: {outcome}. The site is now: {status}.",
  "check.skipped": "The check of {site} did not run. {reason}",
  "action.done": "Done.",

  "jobs.title": "Helper jobs and progress logs",
  "jobs.explain":
    "Every add or repair is a helper job. The progress log is technical and is shown as written.",
  "jobs.empty": "No helper jobs yet.",
  "jobs.kind": "Kind",
  "jobs.site": "Site",
  "jobs.state": "State",
  "jobs.updated": "Updated",
  "jobs.requested": "The helper asks:",
  "jobs.logTitle": "Progress log",
  "jobs.logNone": "Choose Show progress on a job to see its log here.",
  "jobs.logFor": "Progress log of {job}",
  "jobs.logReconnecting": "(reconnecting…)",

  "conn.title": "Connection",
  "conn.intro": "Here you connect ChatGPT to this program and see which apps are connected.",
  "conn.tunnelExplain":
    "ChatGPT reaches this program through a tunnel: a private passage that OpenAI runs between ChatGPT and this Mac. Nothing on this Mac is opened to the internet. A small connection tool from OpenAI (tunnel-client) keeps the tunnel open on this Mac; the program starts and stops it for you.",
  "conn.state": "Connection state: {state}",
  "conn.who.page": "The program does this",
  "conn.who.you": "You",
  "conn.who.youOrAside": "You (or the Aside AI)",
  "conn.labelsDiffer":
    "The buttons and labels on the OpenAI and ChatGPT websites may be worded differently from these steps.",
  "conn.external":
    "This Mac already has a ChatGPT connection that was set up by hand earlier. The program leaves it alone. If you want the program to manage the connection instead, stop the old connection tool first, then fill in the form in step c and confirm Replace.",
  "conn.disconnect": "Disconnect ChatGPT",
  "conn.disconnectExplain":
    "Disconnecting stops the connection tool, deletes the stored runtime key, and makes ChatGPT's sign-in for this tunnel invalid.",
  "confirm.disconnect":
    "Disconnect ChatGPT? The program stops the connection tool and deletes the stored runtime key. ChatGPT can no longer use this program through this tunnel until you connect again.",
  "conn.address": "Connector address (for reference)",
  "conn.addressExplain":
    "ChatGPT connects through the tunnel, so you normally do not need to type this address anywhere.",
  "conn.details.tunnel": "Tunnel id",
  "conn.details.profile": "Connection profile",
  "conn.details.keyStored": "Runtime key stored",
  "conn.details.message": "Last problem",
  "conn.details.tool": "Connection tool version",
  "conn.thisMac": "Do steps e and f on this Mac: the approval page in step f opens in a browser on this Mac.",

  "sub.a.title": "Install the connection tool",
  "sub.a.installed": "The connection tool is installed (version {version}).",
  "sub.a.missing":
    "The connection tool is not installed yet. Install it by following OpenAI's official instructions, then press Check again. The program never downloads it by itself.",
  "sub.a.link": "OpenAI's instructions for the connection tool",
  "sub.a.brew":
    "On a Mac, OpenAI's instructions install it with Homebrew. Paste this into the Terminal app and press Return:",
  "sub.b.title": "Create a tunnel on the OpenAI platform",
  "sub.b.s1": "Open the tunnel page of the OpenAI platform and sign in:",
  "sub.b.s2": "Create a new tunnel. Any name works, for example “Browser Research Bridge”.",
  "sub.b.s3": "Copy the tunnel id. It starts with tunnel_ followed by 32 letters and digits.",
  "sub.b.s4": "Open the API keys page:",
  "sub.c.title": "Create the runtime key and paste it here",
  "sub.c.explain":
    "A runtime key is a secret code from OpenAI that lets the connection tool on this Mac use your tunnel. Treat it like a password: do not show it to anyone or to any AI. The program keeps it in a private file on this Mac and never shows it again.",
  "sub.c.s1": "On the API keys page, create a new key with the permission Tunnels: Read and Use.",
  "sub.c.s2": "Copy the key, paste it and the tunnel id below, and press Connect.",
  "sub.c.tunnelId": "Tunnel id",
  "sub.c.runtimeKey": "Runtime key",
  "sub.c.advanced": "Advanced",
  "sub.c.profile": "Connection profile name",
  "sub.c.profileHelp":
    "Leave this as it is unless you need a second, separate connection. Lowercase letters, digits and hyphens only.",
  "sub.c.submit": "Connect",
  "sub.c.tunnelFormat": "The tunnel id is tunnel_ followed by 32 lowercase letters and digits.",
  "sub.c.replace":
    "A connection profile or runtime key with this name already exists on this Mac. Replace it? If a connection tool is already running some other way, stop it first.",
  "sub.c.sent": "Saved. The program is now setting up this Mac.",
  "sub.d.title": "The program sets up this Mac",
  "sub.d.explain": "The program stores the key, prepares the connection tool, restarts, and starts the tool.",
  "sub.d.waiting": "This happens after step c.",
  "sub.d.retry": "Try again",
  "sub.e.title": "Add the connector in ChatGPT",
  "sub.e.s1": "Open ChatGPT's connector settings:",
  "sub.e.s2": "Under the advanced settings, turn on developer mode.",
  "sub.e.s3":
    "Create a new connector. Name it “Browser Research Bridge”, choose your tunnel ({tunnel}) as the connection instead of a public address, choose OAuth as authentication, and confirm that you trust it.",
  "sub.e.anyTunnel": "the tunnel you created",
  "sub.f.title": "Submit and approve",
  "sub.f.s1":
    "Submit the connector. An approval page of this program opens and asks for the access passphrase. Paste the passphrase you set in step 1 and approve.",
  "sub.g.title": "ChatGPT is connected",
  "sub.g.done": "ChatGPT is connected. Apps with a live sign-in: {count}.",
  "sub.g.waiting": "Waiting for ChatGPT to connect…",
  "sub.g.off": "This is checked when the program is running.",

  "aside.title": "Optional helper: let the Aside AI do this step",
  "aside.explain":
    "Instead of doing this step by hand, you can copy the text below and paste it into the AI inside Aside. It stops before anything secret, and you finish the rest yourself. Nobody has confirmed yet that the Aside AI completes these steps, so the written steps above are the main route.",
  "aside.copy": "Copy the text for the Aside AI",

  "apps.title": "Connected apps",
  "apps.explain":
    "Apps that you approved with the access passphrase. A disconnected app has to be approved again before it can use the program.",
  "apps.empty": "No app has connected yet.",
  "apps.off": "Connected apps are shown when the program is running. See the message at the top of the page.",
  "apps.unnamed": "(unnamed app)",
  "apps.connection": "Connection, valid until {time}",
  "apps.disconnectOne": "Disconnect this connection",
  "apps.disconnectApp": "Disconnect the app",
  "confirm.disconnectApp": "Disconnect {name}? It must be approved with the passphrase again to reconnect.",
  "confirm.disconnectOne":
    "Disconnect this connection of {name}? It must be approved with the passphrase again to reconnect.",
  "apps.d.id": "App id",
  "apps.d.source": "Registered by",
  "apps.d.hosts": "Return addresses",
  "apps.d.lastToken": "Last sign-in",

  "set.title": "Settings",
  "set.intro": "Saving a setting restarts the program's main part automatically. This page stays open.",
  "pp.title": "Access passphrase",
  "pp.isSet": "A passphrase is set. You can replace it here; the current one is never shown.",
  "pp.notSet": "No passphrase is set yet.",
  "pp.invalid": "The current passphrase is too short (fewer than 12 characters). Set a new one.",
  "pp.locked":
    "This passphrase is fixed outside the settings page (by the background service or the terminal), so it cannot be changed here.",
  "pp.field": "New passphrase (at least 12 characters)",
  "pp.create": "Create a passphrase",
  "pp.created":
    "A new passphrase was created. Copy it and keep it somewhere safe, for example in your password manager, before you save. After saving it is never shown again.",
  "pp.forgot": "Forgot it? Set a new one here; the old one is not needed.",
  "pp.disconnect": "Also disconnect all connected apps",
  "pp.disconnectNote":
    "Changing the passphrase does not disconnect apps that are already connected, unless you tick this box.",
  "pp.save": "Save passphrase",
  "pp.empty": "Type a passphrase or press Create a passphrase first.",

  "rt.title": "Helper runtime",
  "rt.explain": "Which AI subscription the site-add helper uses.",
  "rt.onlyClaude": "This version supports only Claude for the helper.",

  "lang.title": "Page language",
  "lang.explain": "The language of this page. It is remembered in this browser and changes nothing else.",

  "adv.title": "Advanced",
  "acct.title": "Aside browser account",
  "acct.explain": "Which signed-in Aside account the program uses. u0 is the first account.",
  "acct.locked": "This account is fixed outside the settings page, so it cannot be changed here.",
  "cache.title": "Saved pages (cache)",
  "cache.explain":
    "Pages the program read recently are kept for a while, so repeated questions are answered faster.",
  "cache.total": "{entries} saved pages, {size} in total",
  "cache.site": "{site}: {entries} pages, {size}",
  "cache.clear": "Clear",
  "cache.clearAll": "Clear all",
  "cache.off": "Saved pages are shown when the program is running.",
  "info.title": "Information (read only)",
  "info.mcpUrl": "Connector address",
  "info.publicUrl": "Public address",
  "info.publicUrlConfigured": "Public address set in a file",
  "info.publicPort": "Program port (reached by ChatGPT through the tunnel)",
  "info.adminPort": "Settings page port",
  "info.dataDir": "Data folder",
  "info.sitesDir": "Sites folder",
  "info.configFile": "Settings file",
  "info.envFile": "Passphrase file",
  "restart.title": "Restart",
  "restart.explain":
    "Stops and starts the program's main part, for example after you fixed a settings file by hand. This page stays open.",
  "restart.button": "Restart the program",

  "save.restarting": "Saved. The program is restarting to use the new setting…",
  "save.noChange": "Nothing changed, so nothing was restarted.",
  "save.appsDisconnected": "All connected apps were disconnected.",
  "save.appsNotDisconnected":
    "The passphrase was changed, but the connected apps could not be disconnected. You can disconnect them by hand under Connection.",
  "confirm.interrupt":
    "The helper is preparing a site right now. This will interrupt that job (you can continue it later with Retry). Continue?",
  "error.pointer.passphrase": "Go to step 1 of Getting started.",
  "error.pointer.restart":
    "Check the message at the top of the page; after fixing it, press Restart under Settings.",
};

const ko = {
  "app.title": "Browser Research Bridge 설정",
  "app.heading": "Browser Research Bridge",
  "app.intro":
    "지금 보고 계신 것은 Browser Research Bridge의 설정 페이지입니다. Browser Research Bridge는 이 Mac에서 실행되는 프로그램으로, ChatGPT가 Aside 브라우저에 로그인해 둔 웹사이트를 검색하고 읽을 수 있게 해 줍니다. 이 설정 페이지는 이 Mac에서만 열리며, 인터넷의 다른 사람은 들어올 수 없습니다.",
  "app.loading": "불러오는 중…",
  "lang.label": "언어",

  "nav.start": "시작하기",
  "nav.sites": "사이트",
  "nav.connection": "연결",
  "nav.settings": "설정",

  "status.program": "프로그램",
  "status.aside": "Aside 브라우저",
  "status.chatgpt": "ChatGPT",
  "status.asideReady": "준비됨",
  "status.asideNotReady": "연결 안 됨",
  "status.unknown": "아직 확인할 수 없음",
  "status.connected": "연결됨",
  "status.notConnected": "아직 연결 안 됨",

  "banner.setupPassphrase":
    "지금은 설정 페이지만 실행 중입니다. 시작하기의 1단계에서 접속 암호를 정하기 전에는 ChatGPT가 이 프로그램을 쓸 수 없습니다.",
  "banner.setupConfig":
    "설정 파일에 잘못된 부분이 있어 지금은 설정 페이지만 실행 중입니다. 아래에서 해당 설정을 고쳐 저장하거나, 파일을 고친 뒤 다시 시작을 누르세요.",
  "banner.setupStart":
    "프로그램을 시작하지 못해 지금은 설정 페이지만 실행 중입니다. 다시 시작을 눌러 다시 시도하세요. 이유는 자세히 보기에 있습니다.",
  "banner.restarting":
    "변경 내용을 적용하려고 프로그램을 다시 시작하는 중입니다. 이 페이지는 그대로 열려 있고, 몇 초 뒤 저절로 새 상태를 보여 줍니다.",
  "banner.restartSlow": "다시 시작이 평소보다 오래 걸리고 있습니다. 이 페이지가 계속 확인하고 있습니다.",
  "banner.restartDone": "프로그램이 다시 실행 중입니다.",
  "banner.restartSetup": "프로그램이 시작되지 않았습니다. {reason}",
  "banner.signedOut":
    "이 설정 페이지의 로그인이 끝났습니다. 보통 프로그램 전체가 다시 시작되었을 때 그렇습니다. 프로그램 폴더에 있는 “Open Settings.command”를 더블클릭해 다시 여세요.",

  "common.details": "자세히 보기",
  "common.copy": "복사",
  "common.copied": "복사했습니다.",
  "common.copyFailed": "복사하지 못했습니다. 글자를 선택해 직접 복사하세요.",
  "common.show": "보기",
  "common.hide": "숨기기",
  "common.save": "저장",
  "common.working": "처리 중…",
  "common.checkAgain": "다시 확인",
  "common.yes": "예",
  "common.no": "아니요",
  "common.never": "없음",
  "common.none": "없음",
  "common.done": "완료",
  "common.close": "닫기",
  "common.optional": "선택 사항",

  "step.done": "완료",
  "step.todo": "할 일",
  "step.unknown": "아직 확인할 수 없음",
  "step.why.need_passphrase": "먼저 접속 암호를 정하세요 (1단계).",
  "step.why.core_off": "지금 프로그램이 실행 중이 아니라 확인할 수 없습니다. 페이지 맨 위의 안내를 보세요.",
  "step.why.restarting": "프로그램이 다시 시작하는 중입니다. 잠시 뒤 다시 확인합니다.",
  "step.why.no_data": "확인하지 못했습니다. 다시 확인을 누르거나 페이지를 새로 고치세요.",

  "start.title": "시작하기",
  "start.intro":
    "다섯 단계를 마치면 ChatGPT에서 검색할 수 있습니다. 각 단계는 스스로 상태를 확인하므로, 언제든 이 목록으로 돌아와 볼 수 있습니다.",
  "start.allDone": "모든 준비가 끝났습니다. 이제 ChatGPT에서 이 프로그램을 쓸 수 있습니다.",

  "step1.title": "접속 암호 정하기",
  "step1.explain":
    "접속 암호는 나만 아는 긴 비밀번호입니다. ChatGPT를 이 프로그램에 처음 연결할 때 한 번 입력하며, 다른 사람이 연결하지 못하게 막아 줍니다. 입력은 브라우저에 열리는 승인 페이지에서 하며, ChatGPT 대화창에 입력하는 것이 아닙니다. 이것을 정하기 전에는 다른 기능이 작동하지 않습니다.",
  "step1.done": "접속 암호가 정해져 있습니다.",

  "step2.title": "Aside 브라우저 준비",
  "step2.explain":
    "이 프로그램은 웹사이트에 로그인해 둔 Aside 브라우저에서 사이트를 엽니다. Aside 앱이 열려 있어야 하고, Aside의 명령줄 도구가 로그인되어 있어야 합니다.",
  "step2.ok": "Aside가 열려 있고 연결됩니다 (계정 {account}).",
  "step2.notOk": "지금 프로그램이 Aside에 연결할 수 없습니다.",
  "step2.howto1": "이 Mac에서 Aside 앱을 여세요.",
  "step2.howto2":
    "Aside가 이미 열려 있다면 명령줄 도구에 로그인하세요. ‘터미널’ 앱을 열고 아래 명령을 붙여 넣은 뒤 Return 키를 누르고, 나오는 안내를 따르세요.",
  "step2.howto3": "그다음 다시 확인을 누르세요.",

  "step3.title": "ChatGPT 연결하기",
  "step3.explain":
    "이 Mac에서 할 일은 프로그램이 모두 합니다. 몇 단계는 OpenAI와 ChatGPT 웹사이트에서 해야 하며, 아래에 차례대로 적혀 있습니다.",
  "step3.done": "ChatGPT가 연결되었습니다.",

  "step4.title": "사이트 추가 도우미 준비",
  "step4.explain":
    "도우미는 새 사이트를 이 프로그램에서 쓸 수 있게 준비해 주는 AI 비서입니다. 사이트의 검색과 기사 구조를 살펴보고, 그 사이트에 필요한 작은 코드를 직접 작성합니다. 이미 쓰고 있는 Claude 또는 ChatGPT 구독으로 작동하며, 이 Mac의 Claude Code 또는 Codex 앱에 로그인되어 있어야 합니다. API 키는 필요 없습니다.",
  "step4.check": "확인",
  "step4.checking": "확인하는 중… AI에 짧은 요청을 한 번 보내며, 1분 정도 걸릴 수 있습니다.",

  "step5.title": "사이트",
  "step5.explain":
    "사이트는 이 프로그램이 대신 검색해 주는 웹사이트입니다. Reuters가 기본으로 들어 있습니다. Aside에서 reuters.com에 로그인한 뒤 지금 확인을 누르세요.",
  "step5.noReuters": "사이트 목록에 Reuters가 없습니다. 아래에서 Reuters나 다른 사이트를 추가할 수 있습니다.",
  "step5.addMore": "다른 사이트를 추가하려면 사이트 탭의 입력 칸을 쓰세요.",
  "step5.goSites": "사이트 열기",

  "helper.title": "도우미",
  "helper.runtime.ready": "{name}: 설치되어 있고 로그인됨",
  "helper.runtime.unknownSignIn": "{name}: 설치되어 있음 (로그인 여부는 확인 버튼으로 알 수 있음)",
  "helper.runtime.notSignedIn": "{name}: 설치되어 있지만 로그인 안 됨",
  "helper.runtime.missing": "{name}: 설치 안 됨",
  "helper.runtime.notShipped": "{name}: 이 버전에서는 쓸 수 없음",
  "helper.wouldUse": "지금 사이트를 추가하면 이것으로 준비합니다: {runtime}.",
  "helper.noneAvailable":
    "이 Mac에서는 Claude Code도 Codex도 쓸 수 없습니다. 둘 중 하나를 설치하고 구독 계정으로 로그인한 뒤 확인을 누르세요.",
  "helper.dataClaude": "Claude를 쓰면 도우미가 살펴보는 페이지 내용이 Anthropic으로 전송됩니다.",
  "helper.dataCodex": "Codex를 쓰면 도우미가 살펴보는 페이지 내용이 OpenAI로 전송됩니다.",
  "helper.lastCheck": "마지막 확인 ({time}): {result}",
  "helper.noCheck": "프로그램이 시작된 뒤 아직 확인하지 않았습니다.",
  "helper.off": "도우미는 프로그램이 실행 중일 때 확인할 수 있습니다.",

  "sites.title": "사이트",
  "sites.addTitle": "사이트 추가",
  "sites.addExplain":
    "사이트 주소를 붙여 넣고 추가를 누르세요. 그러면 도우미가 사이트를 살펴보고 준비합니다. 몇 분 정도 걸리며, 사용 중인 Claude 또는 ChatGPT 구독을 씁니다.",
  "sites.input": "사이트 주소 또는 이름",
  "sites.inputPlaceholder": "https://www.example.com",
  "sites.noteToggle": "도우미에게 메모 남기기",
  "sites.note": "도우미에게 남길 메모",
  "sites.notePlaceholder": "예: 내가 구독한 블로그만 검색",
  "sites.add": "추가",
  "sites.added": "추가했습니다. 도우미가 작업을 시작했으며, 사이트 목록에서 진행 상황을 볼 수 있습니다.",
  "sites.listTitle": "내 사이트",
  "sites.empty": "아직 사이트가 없습니다.",
  "sites.off": "사이트 목록은 프로그램이 실행 중일 때 보입니다. 페이지 맨 위의 안내를 보세요.",
  "sites.offRestarting": "프로그램이 다시 시작하는 중입니다. 사이트 목록은 잠시 뒤 다시 보입니다.",

  "site.do.working":
    "도우미가 이 사이트를 준비하고 있습니다. 몇 분 정도 걸리며, 진행 상황 보기로 확인할 수 있습니다.",
  "site.do.awaiting": "도우미가 먼저 이것을 해 달라고 요청했습니다:",
  "site.do.awaitingThen": "요청한 일을 마친 뒤 다시 시도를 누르세요.",
  "site.do.jobFailed":
    "도우미가 작업을 마치지 못했습니다. 다시 시도를 누르세요. 이유는 자세히 보기에 있습니다.",
  "site.do.login": "Aside에서 {url} 에 로그인한 뒤 지금 확인을 누르세요.",
  "site.do.loginNoUrl": "Aside에서 이 사이트에 로그인한 뒤 지금 확인을 누르세요.",
  "site.do.degraded": "이 사이트는 일부만 작동합니다. 고치기를 누르면 도우미가 고칩니다.",
  "site.do.failed":
    "이 사이트는 작동하지 않습니다. 고치기를 누르면 도우미가 고칩니다. 이유는 자세히 보기에 있습니다.",
  "site.do.onboarding": "사이트를 준비하고 있습니다.",
  "site.do.fine": "정상 작동 중입니다. 할 일이 없습니다.",
  "site.do.checkFirst": "준비되었습니다. 지금 확인을 한 번 눌러 작동하는지 확인하세요.",
  "site.do.unknown": "이 상태에서 권하는 조치가 없습니다.",
  "site.checking": "확인하는 중…",
  "site.lastChecked": "마지막 확인: {time}",
  "site.d.key": "사이트 키",
  "site.d.addresses": "주소",
  "site.d.capabilities": "할 수 있는 일",
  "site.d.lastFailure": "마지막 문제",
  "site.d.folderProblem": "폴더 문제",
  "site.d.job": "최근 도우미 작업",
  "site.d.runtime": "도우미가 사용한 AI",
  "site.d.cache": "저장된 페이지",
  "site.d.lastChecked": "마지막 확인",
  "job.d.id": "작업 ID",
  "job.d.attempts": "시도 횟수",
  "job.d.commit": "저장된 버전 (커밋)",
  "job.d.lang": "도우미 메시지 언어",
  "step2.d.action": "권장 조치",

  "action.retry": "다시 시도",
  "action.repair": "고치기",
  "action.check": "지금 확인",
  "action.cancel": "작업 취소",
  "action.remove": "삭제",
  "action.showLog": "진행 상황 보기",

  "confirm.remove":
    "{site} 사이트를 삭제할까요? 사이트 폴더, 저장된 상태, 저장된 페이지가 모두 지워지며 되돌릴 수 없습니다.",
  "prompt.repair": "{site} 고치기: 도우미에게 남길 메모를 적을 수 있습니다 (선택 사항).",
  "check.result": "{site} 확인 결과: {outcome}. 지금 사이트 상태: {status}.",
  "check.skipped": "{site} 확인이 실행되지 않았습니다. {reason}",
  "action.done": "완료했습니다.",

  "jobs.title": "도우미 작업과 진행 기록",
  "jobs.explain":
    "사이트를 추가하거나 고칠 때마다 도우미 작업이 하나 생깁니다. 진행 기록은 기술적인 내용이라 원문 그대로 보여 줍니다.",
  "jobs.empty": "아직 도우미 작업이 없습니다.",
  "jobs.kind": "종류",
  "jobs.site": "사이트",
  "jobs.state": "상태",
  "jobs.updated": "마지막 변경",
  "jobs.requested": "도우미의 요청:",
  "jobs.logTitle": "진행 기록",
  "jobs.logNone": "작업의 진행 상황 보기를 누르면 여기에 기록이 나옵니다.",
  "jobs.logFor": "{job} 진행 기록",
  "jobs.logReconnecting": "(다시 연결하는 중…)",

  "conn.title": "연결",
  "conn.intro": "여기서 ChatGPT를 이 프로그램에 연결하고, 연결된 앱을 확인합니다.",
  "conn.tunnelExplain":
    "ChatGPT는 터널을 통해 이 프로그램에 들어옵니다. 터널은 OpenAI가 ChatGPT와 이 Mac 사이에 만들어 주는 전용 통로이며, 이 Mac을 인터넷에 여는 것이 아닙니다. 이 Mac에서는 OpenAI의 작은 연결 도구(tunnel-client)가 터널을 열어 두며, 이 도구는 프로그램이 알아서 켜고 끕니다.",
  "conn.state": "연결 상태: {state}",
  "conn.who.page": "프로그램이 합니다",
  "conn.who.you": "직접 하세요",
  "conn.who.youOrAside": "직접 하거나 Aside AI에게 맡기세요",
  "conn.labelsDiffer": "OpenAI와 ChatGPT 웹사이트의 버튼과 이름은 이 안내와 다르게 적혀 있을 수 있습니다.",
  "conn.external":
    "이 Mac에는 예전에 직접 설정한 ChatGPT 연결이 이미 있습니다. 프로그램은 그 연결을 건드리지 않습니다. 프로그램이 대신 관리하게 하려면 먼저 예전 연결 도구를 멈춘 뒤, c단계의 입력 칸을 채우고 바꾸기를 확인하세요.",
  "conn.disconnect": "ChatGPT 연결 끊기",
  "conn.disconnectExplain":
    "연결을 끊으면 연결 도구가 멈추고, 저장된 런타임 키가 지워지며, 이 터널로 한 ChatGPT의 로그인이 무효가 됩니다.",
  "confirm.disconnect":
    "ChatGPT 연결을 끊을까요? 프로그램이 연결 도구를 멈추고 저장된 런타임 키를 지웁니다. 다시 연결하기 전까지 ChatGPT는 이 터널로 프로그램을 쓸 수 없습니다.",
  "conn.address": "커넥터 주소 (참고용)",
  "conn.addressExplain":
    "ChatGPT는 터널을 통해 연결하므로, 보통은 이 주소를 어디에도 입력할 필요가 없습니다.",
  "conn.details.tunnel": "터널 ID",
  "conn.details.profile": "연결 프로필",
  "conn.details.keyStored": "런타임 키 저장됨",
  "conn.details.message": "마지막 문제",
  "conn.details.tool": "연결 도구 버전",
  "conn.thisMac": "e와 f 단계는 이 Mac에서 하세요. f단계의 승인 페이지가 이 Mac의 브라우저에서 열립니다.",

  "sub.a.title": "연결 도구 설치",
  "sub.a.installed": "연결 도구가 설치되어 있습니다 (버전 {version}).",
  "sub.a.missing":
    "연결 도구가 아직 설치되어 있지 않습니다. OpenAI의 공식 안내를 따라 설치한 뒤 다시 확인을 누르세요. 프로그램이 스스로 내려받지는 않습니다.",
  "sub.a.link": "연결 도구에 대한 OpenAI 공식 안내",
  "sub.a.brew":
    "Mac에서는 OpenAI 안내대로 Homebrew로 설치합니다. ‘터미널’ 앱에 아래 명령을 붙여 넣고 Return 키를 누르세요.",
  "sub.b.title": "OpenAI 플랫폼에서 터널 만들기",
  "sub.b.s1": "OpenAI 플랫폼의 터널 페이지를 열고 로그인하세요:",
  "sub.b.s2": "새 터널을 만드세요. 이름은 아무것이나 괜찮습니다. 예: “Browser Research Bridge”.",
  "sub.b.s3": "터널 ID를 복사하세요. tunnel_ 뒤에 영문자와 숫자 32자가 붙은 형태입니다.",
  "sub.b.s4": "API 키 페이지를 여세요:",
  "sub.c.title": "런타임 키를 만들어 여기에 붙여 넣기",
  "sub.c.explain":
    "런타임 키는 이 Mac의 연결 도구가 내 터널을 쓸 수 있게 해 주는, OpenAI에서 발급하는 비밀 코드입니다. 비밀번호처럼 다루세요. 다른 사람이나 AI에게 보여 주지 마세요. 프로그램은 이 키를 이 Mac의 비공개 파일에 보관하며 다시 보여 주지 않습니다.",
  "sub.c.s1": "API 키 페이지에서 Tunnels: Read 와 Use 권한이 있는 새 키를 만드세요.",
  "sub.c.s2": "키를 복사해 터널 ID와 함께 아래에 붙여 넣고 연결을 누르세요.",
  "sub.c.tunnelId": "터널 ID",
  "sub.c.runtimeKey": "런타임 키",
  "sub.c.advanced": "고급",
  "sub.c.profile": "연결 프로필 이름",
  "sub.c.profileHelp":
    "따로 두 번째 연결이 필요한 경우가 아니면 그대로 두세요. 영문 소문자, 숫자, 하이픈(-)만 쓸 수 있습니다.",
  "sub.c.submit": "연결",
  "sub.c.tunnelFormat": "터널 ID는 tunnel_ 뒤에 영문 소문자와 숫자 32자가 붙은 형태입니다.",
  "sub.c.replace":
    "이 이름의 연결 프로필이나 런타임 키가 이 Mac에 이미 있습니다. 바꿀까요? 다른 방법으로 연결 도구가 이미 실행 중이라면 먼저 그것을 멈추세요.",
  "sub.c.sent": "저장했습니다. 프로그램이 이 Mac을 설정하고 있습니다.",
  "sub.d.title": "프로그램이 이 Mac을 설정",
  "sub.d.explain": "프로그램이 키를 저장하고, 연결 도구를 준비하고, 다시 시작한 뒤 도구를 켭니다.",
  "sub.d.waiting": "c단계를 마치면 진행됩니다.",
  "sub.d.retry": "다시 시도",
  "sub.e.title": "ChatGPT에 커넥터 추가",
  "sub.e.s1": "ChatGPT의 커넥터 설정을 여세요:",
  "sub.e.s2": "고급 설정에서 개발자 모드를 켜세요.",
  "sub.e.s3":
    "새 커넥터를 만드세요. 이름은 “Browser Research Bridge”로 하고, 연결 방식은 공개 주소 대신 내 터널({tunnel})을 고르고, 인증은 OAuth를 고른 뒤, 신뢰한다고 확인하세요.",
  "sub.e.anyTunnel": "내가 만든 터널",
  "sub.f.title": "제출하고 승인하기",
  "sub.f.s1":
    "커넥터를 제출하세요. 이 프로그램의 승인 페이지가 열리고 접속 암호를 묻습니다. 1단계에서 정한 접속 암호를 붙여 넣고 승인하세요.",
  "sub.g.title": "ChatGPT 연결 완료",
  "sub.g.done": "ChatGPT가 연결되었습니다. 로그인이 살아 있는 앱: {count}개.",
  "sub.g.waiting": "ChatGPT가 연결되기를 기다리는 중…",
  "sub.g.off": "프로그램이 실행 중일 때 확인합니다.",

  "aside.title": "선택 도우미: Aside AI에게 이 단계 맡기기",
  "aside.explain":
    "이 단계를 직접 하는 대신, 아래 글을 복사해 Aside 안의 AI에게 붙여 넣을 수 있습니다. AI는 비밀 정보가 필요한 곳 직전에 멈추고, 나머지는 직접 마무리합니다. Aside AI가 이 단계를 끝까지 해낸다는 것은 아직 확인되지 않았으므로, 위에 적힌 안내가 기본 방법입니다.",
  "aside.copy": "Aside AI용 글 복사",

  "apps.title": "연결된 앱",
  "apps.explain": "접속 암호로 승인한 앱입니다. 연결을 끊은 앱은 다시 승인해야 프로그램을 쓸 수 있습니다.",
  "apps.empty": "아직 연결된 앱이 없습니다.",
  "apps.off": "연결된 앱은 프로그램이 실행 중일 때 보입니다. 페이지 맨 위의 안내를 보세요.",
  "apps.unnamed": "(이름 없는 앱)",
  "apps.connection": "연결, {time}까지 유효",
  "apps.disconnectOne": "이 연결 끊기",
  "apps.disconnectApp": "앱 연결 끊기",
  "confirm.disconnectApp": "{name} 앱의 연결을 끊을까요? 다시 연결하려면 접속 암호로 다시 승인해야 합니다.",
  "confirm.disconnectOne":
    "{name} 앱의 이 연결을 끊을까요? 다시 연결하려면 접속 암호로 다시 승인해야 합니다.",
  "apps.d.id": "앱 ID",
  "apps.d.source": "등록 방식",
  "apps.d.hosts": "돌아갈 주소",
  "apps.d.lastToken": "마지막 로그인",

  "set.title": "설정",
  "set.intro":
    "설정을 저장하면 프로그램의 주요 부분이 자동으로 다시 시작됩니다. 이 페이지는 그대로 열려 있습니다.",
  "pp.title": "접속 암호",
  "pp.isSet": "접속 암호가 정해져 있습니다. 여기서 새 암호로 바꿀 수 있으며, 지금 암호는 보여 주지 않습니다.",
  "pp.notSet": "아직 접속 암호가 없습니다.",
  "pp.invalid": "지금 접속 암호가 너무 짧습니다 (12자 미만). 새 암호를 정하세요.",
  "pp.locked":
    "이 접속 암호는 설정 페이지 밖(백그라운드 서비스나 터미널)에서 정해져 있어 여기서 바꿀 수 없습니다.",
  "pp.field": "새 접속 암호 (12자 이상)",
  "pp.create": "암호 만들기",
  "pp.created":
    "새 암호를 만들었습니다. 저장하기 전에 복사해서 비밀번호 관리 앱 같은 안전한 곳에 보관하세요. 저장한 뒤에는 다시 보여 주지 않습니다.",
  "pp.forgot": "잊어버렸나요? 여기서 새 암호를 정하면 됩니다. 예전 암호는 필요 없습니다.",
  "pp.disconnect": "연결된 앱도 모두 연결 끊기",
  "pp.disconnectNote": "이 칸을 체크하지 않으면, 암호를 바꿔도 이미 연결된 앱은 그대로 연결되어 있습니다.",
  "pp.save": "접속 암호 저장",
  "pp.empty": "먼저 암호를 입력하거나 암호 만들기를 누르세요.",

  "rt.title": "도우미가 쓸 AI",
  "rt.explain": "사이트 추가 도우미가 어떤 AI 구독을 쓸지 정합니다.",
  "rt.onlyClaude": "이 버전의 도우미는 Claude만 지원합니다.",

  "lang.title": "페이지 언어",
  "lang.explain": "이 페이지의 언어입니다. 이 브라우저에 기억되며, 다른 것은 바꾸지 않습니다.",

  "adv.title": "고급",
  "acct.title": "Aside 브라우저 계정",
  "acct.explain": "프로그램이 쓸 Aside 로그인 계정입니다. u0이 첫 번째 계정입니다.",
  "acct.locked": "이 계정은 설정 페이지 밖에서 정해져 있어 여기서 바꿀 수 없습니다.",
  "cache.title": "저장된 페이지 (캐시)",
  "cache.explain": "최근에 읽은 페이지를 잠시 보관해 두어, 같은 질문에 더 빨리 답합니다.",
  "cache.total": "저장된 페이지 {entries}개, 모두 {size}",
  "cache.site": "{site}: 페이지 {entries}개, {size}",
  "cache.clear": "비우기",
  "cache.clearAll": "모두 비우기",
  "cache.off": "저장된 페이지는 프로그램이 실행 중일 때 보입니다.",
  "info.title": "정보 (보기만 가능)",
  "info.mcpUrl": "커넥터 주소",
  "info.publicUrl": "공개 주소",
  "info.publicUrlConfigured": "파일에 공개 주소가 설정됨",
  "info.publicPort": "프로그램 포트 (ChatGPT가 터널로 접속)",
  "info.adminPort": "설정 페이지 포트",
  "info.dataDir": "데이터 폴더",
  "info.sitesDir": "사이트 폴더",
  "info.configFile": "설정 파일",
  "info.envFile": "접속 암호 파일",
  "restart.title": "다시 시작",
  "restart.explain":
    "프로그램의 주요 부분을 멈췄다가 다시 시작합니다. 예를 들어 설정 파일을 직접 고친 뒤에 씁니다. 이 페이지는 그대로 열려 있습니다.",
  "restart.button": "프로그램 다시 시작",

  "save.restarting": "저장했습니다. 새 설정을 적용하려고 프로그램을 다시 시작하는 중입니다…",
  "save.noChange": "바뀐 것이 없어 다시 시작하지 않았습니다.",
  "save.appsDisconnected": "연결된 앱을 모두 연결 끊었습니다.",
  "save.appsNotDisconnected":
    "접속 암호는 바뀌었지만 연결된 앱의 연결을 끊지 못했습니다. 연결 탭에서 직접 끊을 수 있습니다.",
  "confirm.interrupt":
    "지금 도우미가 사이트를 준비하고 있습니다. 계속하면 그 작업이 중단됩니다 (나중에 다시 시도로 이어서 할 수 있습니다). 계속할까요?",
  "error.pointer.passphrase": "시작하기의 1단계로 가세요.",
  "error.pointer.restart": "페이지 맨 위의 안내를 확인하고, 문제를 고친 뒤 설정 탭의 다시 시작을 누르세요.",
};

export const DICTIONARIES = { en, ko };

/** The {placeholder} names a text uses. */
export function placeholders(text) {
  return [...String(text).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

/** The text of `key` in `lang` (English, then the key itself, when missing) with {placeholders} filled. */
export function t(lang, key, vars = {}) {
  const text = (DICTIONARIES[lang] ?? en)[key] ?? en[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (whole, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole,
  );
}
