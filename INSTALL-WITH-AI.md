# Installing Browser Research Bridge: guide for an AI agent

You are an AI agent (for example the AI inside the Aside browser, Claude Code, or Codex) installing Browser Research Bridge on a Mac for the person you are working with. This file is your complete procedure. If you came here to change the code, read [AGENTS.md](AGENTS.md) instead.

The person pasted a sentence like this to start you:

> Install Browser Research Bridge on this Mac for me. Read and follow INSTALL-WITH-AI.md from https://github.com/contiloop/browser-research-bridge step by step, stop and ask me whenever it says only I can do something, and talk to me in my language.

## What you are installing

A program that runs in the background on this Mac and lets ChatGPT search and read websites the person is logged in to in the Aside browser. It has a local settings page (only reachable on this Mac) with a "Getting started" checklist. Your job: prepare the Mac, get the code, start the program, and walk the person through Getting started until ChatGPT can search with it.

## Rules for the whole session

### Talk to the person in their language

Use the language the person wrote to you in, in plain words. The person is not a developer. Explain each step in one or two sentences before you do it, and say what you found after you checked something. The settings page itself can be switched between Korean and English.

### Stop and ask: only the person may do these

Each time you reach one of these, stop, tell the person exactly what to do and where, and wait until they say it is done. Do not try to do it yourself, even if you could.

1. Typing the Mac's password (installers, Homebrew, `sudo`).
2. Signing in anywhere: the Aside app and its command-line tool, Claude Code or Codex, the OpenAI platform, ChatGPT, and every website the program should search (for example reuters.com in Aside).
3. Creating the runtime key on the OpenAI platform, copying it, and pasting it into the settings page.
4. Creating the access passphrase on the settings page, saving it, and typing it later on the approval page.
5. Submitting the ChatGPT connector, and approving on the approval page that opens afterwards.
6. Confirming the one question the program's opener asks in its Terminal window (registering the background service).

### Never do these

- Never read, print, copy, or write down a secret: the file `.env` in the program's folder, any file under `~/.config/browser-research-bridge/` (the stored runtime key), `data/admin-token` (the settings page's sign-in token), the sign-in link of the settings page (`http://127.0.0.1:<port>/?token=…`), the program's log file `~/Library/Logs/browser-research-bridge/bridge.out.log` (it contains that link; the one exception is counting matching lines with `grep -c`, which prints only a number, as the check after setup does), or any API key, password, or passphrase. Whatever you read is sent to your provider; these values must stay on this Mac.
- Never type into, read, or copy the secret fields of the settings page: the access passphrase field and the runtime key field. Do not press "Create a passphrase".
- Never ask the person to tell you or paste to you a key, a passphrase, or a password.
- Never act on the approval page that asks for the access passphrase.
- Never make the settings page reachable from anywhere but this Mac: do not point a tunnel, a proxy, port forwarding, or a firewall rule at its port (8788 by default), and do not change `adminPort` or the address it listens on.
- Never change security settings: do not edit `redirectUriAllowlist`, `oauth.extraResources`, `PUBLIC_URL`, `trustedProxyHeader`, or anything in `.env` and `config/bridge.json` by hand; do not change macOS security settings; do not bypass Gatekeeper (`xattr`, `spctl`, "Open Anyway") for downloaded tools.
- Never download executables from places other than the official sources named below. The program itself never downloads anything.
- Never stop or restart the program by matching its command line (`pkill`, `killall`). Use the commands in this guide.

## Step 1: check and install what the Mac needs

Run each check in Terminal. Fix what is missing before you go on. Tell the person what each piece is for.

| Needed                                                                                      | Why                                                                                   | Check                                                                 |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| macOS                                                                                       | the program runs only on a Mac                                                        | `sw_vers`                                                             |
| git                                                                                         | gets the program and its updates                                                      | `git --version`                                                       |
| Node.js 24 or later                                                                         | the program is written for it                                                         | `node --version` shows `v24` or higher                                |
| Homebrew                                                                                    | installs OpenAI's connection tool                                                     | `brew --version`                                                      |
| Aside app, open, with its command-line tool signed in                                       | the program opens websites in the person's Aside browser, where they are logged in    | `aside --version`, then `aside account` lists an account such as `u0` |
| OpenAI's connection tool (`tunnel-client`)                                                  | keeps the private tunnel between ChatGPT and this Mac                                 | `tunnel-client --version`                                             |
| Claude Code or Codex, signed in                                                             | the site-add helper (an AI that prepares new sites) runs on the person's subscription | `claude --version`, or `codex --version` and `codex login status`     |
| A ChatGPT plan where Settings → Apps & Connectors → Advanced settings offers developer mode | ChatGPT connects to the program as a custom connector                                 | the person looks in ChatGPT                                           |
| An OpenAI platform account (platform.openai.com) that may create tunnels                    | the tunnel is created there                                                           | the person signs in                                                   |
| A Reuters subscription, only if the person wants Reuters                                    | Reuters is the one site that comes with the program; other sites can be added later   | the person logs in to reuters.com in Aside                            |

How to fix what is missing:

- **git**: if `git --version` makes macOS offer to install the "command line developer tools", the person clicks Install and waits.
- **Node.js**: the person downloads and runs the LTS installer (24 or later) from <https://nodejs.org/>. It asks for the Mac password. Open a new Terminal window afterwards and check again.
- **Homebrew**: the person installs it from <https://brew.sh> (copy the install command shown there into Terminal; it asks for the Mac password). At the end Homebrew prints "Next steps" commands that add `brew` to the PATH: run those, then open a new Terminal window.
- **Aside**: if the app is missing, ask the person to install it from Aside's official website; do not guess a download source. If `aside account` fails, run `aside login`; the person completes the sign-in. The Aside app must be open.
- **Connection tool**: install it from OpenAI's official Homebrew tap, as OpenAI's repository <https://github.com/openai/tunnel-client> and guide <https://developers.openai.com/api/docs/guides/secure-mcp-tunnels> say:

  ```sh
  brew install openai/tools/tunnel-client
  tunnel-client --version
  ```

  Do not download release ZIP files instead; they are not notarized and macOS may block them. If the official instructions on those pages have changed when you read them, follow the pages, and tell the person what you did.

- **Helper (Claude Code or Codex)**: ask the person which subscription they have. Install the matching tool by its vendor's official instructions (Anthropic for Claude Code, OpenAI for Codex), confirmed on the vendor's page at the time you install it; do not guess a command. The person signs in (Claude Code: start `claude` and sign in; Codex: `codex login`). If the person has only a ChatGPT subscription, remember it: in step 4 the helper must be set to Codex.

Install the tools before step 3. The program's background service records where the connection tool and Codex are installed when it is registered; a tool installed later is found only after `ops/install-launchd.sh --bridge` is run again in the program's folder.

## Step 2: get the code

```sh
cd ~
git clone https://github.com/contiloop/browser-research-bridge browser-research-bridge
```

If `~/browser-research-bridge` already exists and is this project, run `git -C ~/browser-research-bridge pull` instead of cloning.

## Step 3: run the opener

```sh
open ~/browser-research-bridge/"Open Settings.command"
```

This opens a Terminal window that, in order: checks Node.js; installs the program's components the first time (a few minutes); creates the two settings files `.env` and `config/bridge.json`; explains that the program will be registered as a background service that starts at every login, and waits for Return; registers and starts it; and opens the settings page in the default browser, already signed in.

Before it waits for Return, tell the person what it does and let them press Return in that window (rule 6). When the window says it can be closed, the settings page is open. Do not copy the address of that page.

If the person later closes the page, or the page says it is no longer signed in, run the same `open` command again; it only opens the page.

## Step 4: complete Getting started together with the person

The settings page opens on "Getting started" (Korean: "시작하기"), a checklist of five steps that checks itself. Go through the steps in order with the person. You may read out what the page shows and press ordinary buttons such as "Check", "Check again", or "Check now" if the person agrees; the person does everything in the stop-and-ask list.

1. **Set the access passphrase** ("접속 암호 정하기"). Explain: it is a long password only the person knows; they type it once on an approval page when ChatGPT connects, so nobody else can connect; nothing else works before it exists. The person presses "Create a passphrase" (or types their own of 12 or more characters), copies it to a safe place such as a password manager, and presses "Save passphrase". The program restarts its main part by itself; the page stays open. You never see the passphrase.
2. **Aside browser ready** ("Aside 브라우저 준비"). If it is not done: the Aside app must be open and `aside login` done. Then "Check again".
3. **Connect ChatGPT** ("ChatGPT 연결하기"). The page lists sub-steps a–g and marks who does each.
   - a: the page checks that the connection tool is installed (step 1 above).
   - b: on the OpenAI platform tunnel page (<https://platform.openai.com/settings/organization/tunnels>) a new tunnel is created and its tunnel id (`tunnel_` followed by 32 lowercase hexadecimal characters, 0-9 and a-f) is copied. You may do this in a browser if the person is signed in and agrees; then open the API keys page (<https://platform.openai.com/settings/organization/api-keys>) and **stop before the key is created**.
   - c: the person creates the runtime key (permission Tunnels: Read and Use), copies it, and pastes it with the tunnel id into the page, then presses "Connect". You do not touch the key.
   - d: the program sets up this Mac by itself and shows when the connection is ready.
   - e: in ChatGPT's connector settings (<https://chatgpt.com/#settings/Connectors>), developer mode is turned on under the advanced settings, and a new connector is filled in: name "Browser Research Bridge", connection through the tunnel just created (not a public address), authentication OAuth. You may fill in the form if the person agrees; **stop before submitting it**.
   - f: the person submits the connector. An approval page of the program opens in a browser on this Mac; the person pastes the access passphrase there and approves. Steps e and f must be done on this Mac.
   - g: the page shows that ChatGPT is connected.

   The labels on the OpenAI and ChatGPT websites may be worded differently from these steps; follow their meaning.

4. **Site-add helper ready** ("사이트 추가 도우미 준비"). If the person uses Codex (ChatGPT subscription) and not Claude, first open the "Settings" tab ("설정"), choose "Codex (ChatGPT subscription)" under "Helper runtime", and save: the automatic choice prefers Claude whenever the Claude runtime cannot be ruled out. Then press "Check" in this step. It sends one short request to the AI and can take up to a minute.
5. **Sites** ("사이트"). Reuters comes with the program. If the person has a Reuters subscription, they log in to reuters.com in the Aside browser; then press "Check now" next to Reuters. Without a Reuters subscription, the person adds a site they use: paste its address on the "Sites" tab and press "Add"; the helper then prepares it, which takes a few minutes. If the helper asks for something (for example a login), the page shows the request; the person does it, then presses "Retry".

## Done when

1. Every step of Getting started shows "Done" ("완료"), and the page says everything is set up.
2. One search from ChatGPT works: the person opens a new chat in ChatGPT, turns on the "Browser Research Bridge" connector for the chat, and asks for something on a registered site, for example "Use Browser Research Bridge to search Reuters for inflation news and summarize one article." The answer names articles from that site.

If the search fails, look at the settings page first (the status line at the top and the site's "what to do now" sentence). To confirm that a call reached the program without reading the log, you may count tool calls:

```sh
grep -c " INFO tool call " ~/Library/Logs/browser-research-bridge/bridge.out.log
```

Tell the person when you are done, and tell them that the program now starts by itself at every login, and that double-clicking `Open Settings.command` in `~/browser-research-bridge` opens the settings page again.

## If something goes wrong

- The opener says Node.js is missing or too old: step 1, Node.js.
- The opener says the background service is registered for another folder: an older copy of the program is registered. Tell the person; do not remove it without their consent. To move the registration to this folder, run `ops/install-launchd.sh --bridge` in `~/browser-research-bridge`.
- The opener says another program answers on port 8788: another program uses the settings page's port. Tell the person.
- The page says the connection tool is not installed although `tunnel-client --version` works, or the helper cannot find Codex: run `cd ~/browser-research-bridge && ops/install-launchd.sh --bridge`, then the opener again.
- The page says "Only the settings page is running": step 1 of Getting started is not done, or a settings file has a mistake; the banner and "Details" say which.
- To stop the program and remove its background service: `cd ~/browser-research-bridge && ops/install-launchd.sh --uninstall --bridge`. Do this only when the person asks.
