# Running on Ubuntu and Windows

Nobody has run Roundstorm on either yet. The daemon has been made platform-aware
and the Windows rules are covered by tests, but they are asserted rather than
observed — the first real attempt will find something. This page is the shortest
path to finding it.

## Two ways in, and the cheap one first

### 1. Just use the interface, from the Mac's daemon

If the machines are on the same network, nothing needs installing. On the Mac:

```bash
ROUNDSTORM_HOST=0.0.0.0 node dist-server/index.mjs
```

Then open `http://<mac-ip>:8787` in Firefox, Chrome or Edge on the other machine.

That verifies the whole interface — layout, keyboard, copy, search, the manual —
under a different browser engine, and it needs no port at all. It does **not**
exercise the daemon's platform code, because the daemon is still running on macOS.

> **This exposes an unauthenticated API that can start processes on the Mac.**
> At the workstation and full-local tiers that includes reading files and running
> commands. Use it on a network you trust, and stop it when you are done. The
> default bind is loopback and stays that way unless `ROUNDSTORM_HOST` is set.

### 2. Run it properly on the machine

```bash
git clone https://github.com/carlok/roundstorm.git
cd roundstorm
npm install
npm run build
node dist-server/index.mjs        # then open http://127.0.0.1:8787
```

Needs **Node 22.13 or newer** — storage is `node:sqlite`, which landed in 22.5 but stayed behind `--experimental-sqlite` until 22.13.
Nothing else: no Rust, no WebKitGTK, no WebView2. The desktop shell is macOS-only
and is not involved.

At least one brain has to be installed and logged in, or the rooms will run and
every agent will report that it could not answer. All four are available on both
platforms: `claude`, `codex`, `agy`, `cursor-agent`.

## What to check, in order

Each step tells you something different, so stop at the first failure and report
that rather than running the rest.

| # | Check | What a failure means |
|---|---|---|
| 1 | `node --version` is ≥ 22.13 | Nothing else will work. |
| 2 | Daemon prints `storage node:sqlite` | Storage opened; the data directory is writable. |
| 3 | The banner's `data` path looks native | Linux: `~/.local/share/roundstorm`. Windows: `%APPDATA%\Roundstorm`. A `Library/Application Support` here is a bug. |
| 4 | `brains` line shows a ✔ | Binary resolution works. **This is the most likely Windows failure** — a ✖ for a brain that is installed means `PATHEXT` or the search directories are wrong. |
| 5 | `http://127.0.0.1:8787` renders the app | Static serving and the SPA fallback. |
| 6 | A DM to one agent gets a reply | The spawn path end to end: shims, environment, streaming. |
| 7 | A two-round deliberation completes | Concurrency, and turn cancellation. |
| 8 | Ctrl-C leaves nothing behind | Process-tree termination. On Windows check Task Manager for stray `node`, `claude` or `codex`. |

## Where the Windows rules live

If step 4 or 6 fails, the relevant code is in one file:
`server/src/adapters/platform.ts` — `PATHEXT` handling, whether a binary needs a
shell, the command-line ceiling, and which directories are searched. Its tests
(`platform.test.ts`) pass the platform in, so a wrong rule can be reproduced and
fixed from any machine.

## Known rough edges

- **Long prompts on Windows.** The command line is capped at 32767 bytes, or 8191
  through a `.cmd` shim, and every adapter passes the prompt as an argument. A
  long transcript will be refused with an explanation rather than a spawn error —
  but it will be refused. `claude` installs as a `.cmd` and gets the lower limit;
  a natively installed brain gets the higher one.
- **codex authentication on Windows.** Its isolated home symlinks `auth.json`,
  which needs Developer Mode; without it the daemon falls back to copying. If
  codex reports itself unauthenticated, that fallback is the place to look.
- **Sandbox tiers.** Capability tiers map to codex's seatbelt on macOS and
  Landlock on Linux. Windows has no equivalent, so treat the workstation and
  full-local tiers there as advisory.
- **Keyboard hints** still say ⌘ throughout the interface. The handlers accept
  Ctrl; only the labels are wrong.
