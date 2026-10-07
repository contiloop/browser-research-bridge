# 0011 — Setup-only mode and in-process core restart

## Context

The project is published for people who cannot code. Until now the bridge refused to start without a valid `BRIDGE_PASSPHRASE`, so a first-time user had to edit `.env` by hand before anything worked, and every settings change meant stopping the process, editing a file, starting it again, and fetching a new one-time link for the dashboard. The purpose of the old rule was "the public side is never exposed without a passphrase".

## Decision

One process has two parts. The settings page (the dashboard listener on `127.0.0.1:<adminPort>`, the settings store, run-mode control, and the ChatGPT connection service) starts once and stays up for the life of the process. The core (everything `createApp` builds: public listener, OAuth, tools, registry, jobs, health checks, browser port) runs under run-mode control with three modes, `setup`, `running`, and `restarting`.

- Without a valid passphrase, with a configuration error, or after a failed start, the process stays up in `setup`: only the settings page runs, the public port is not bound, and no connection tool is started. `problem.code` is `passphrase_missing`, `passphrase_too_short`, `config_invalid`, or `start_failed`.
- Saving a setting on the page writes the files and restarts the core in-process (stop → re-read the files → new core → start). The settings page, its admin token, and its cookie survive the restart.
- Only a settings-page port that cannot be bound ends the process.

## Alternatives

- **Keep refusing to start; ask for the passphrase in a small window before start**: puts the first step outside the page and still needs a restart for every change.
- **Restart the whole process on every save** (let launchd bring it back): the page would lose its sign-in each time and the user would need a new link.
- **A second, separate setup page**: two pages with the same protections to maintain, and confusing for the user.

## Consequences

- Hard gate 1 is reworded: "no public side without a passphrase" instead of "starting must fail".
- The settings page's location (port, data folder) must be resolvable even from a malformed configuration file (`resolveSettingsPageLocation`).
- Every core start builds a new core from the files; hooks start and stop the managed connection tool with it.
- Saves, restarts, and ChatGPT setup are serialized (`busy`) and refuse to interrupt a running helper job without confirmation (`job_running`).
- Code changes on disk still need a process restart; the in-process restart only re-reads settings.
