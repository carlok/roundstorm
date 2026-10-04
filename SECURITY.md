# Security

Roundstorm is a local-first desktop app that runs AI coding agents on your own
machine. At the upper capability tiers those agents read files and execute
programs, so the security model is worth stating plainly rather than leaving to be
discovered.

## Reporting

Open a [private security advisory](https://github.com/carlok/roundstorm/security/advisories/new).
Please don't use a public issue for anything that affects a running install.

There is no bounty and no SLA — this is a personal project. Expect a reply in days,
not hours.

## The model, in one paragraph

The daemon is an unauthenticated HTTP service bound to `127.0.0.1`. Anything
running as you can drive it fully, and that is by design: it is a local tool, not a
server. What it defends against is a *website* reaching it, and against a stored
value quietly granting an agent more than it should.

## What is enforced

- **Loopback by default.** `ROUNDSTORM_HOST` can widen it, prints a warning when it
  does, and records an audit event.
- **Origin and Host checks** on both `/api` and `/ws`. A page whose `Origin` is not
  this app is refused, and a `Host` that is a name rather than an IP literal or
  `localhost` is refused — the second is what stops DNS rebinding, which the first
  cannot. Overridable via `ROUNDSTORM_ALLOWED_ORIGINS` / `ROUNDSTORM_ALLOWED_HOSTS`.
- **Tiers fail closed.** Tier values are validated at every route that accepts one,
  and every tier-to-flag lookup treats an unrecognised value as the most
  restrictive tier rather than falling through to a permissive default.
- **File access needs a working directory** that exists. It is re-checked each turn,
  so a directory deleted mid-run downgrades the tier instead of letting the agent
  run wherever the daemon happens to be.
- **`--dangerously-skip-permissions` is never passed.** To anything, at any tier.

## What is not

- **No authentication, and no multi-user story.** Any local process has full access.
- **The tier flags are advisory.** They are the CLIs' own modes, not a kernel
  sandbox. None of these tools confines shell execution to a directory, so at the
  `full` tier an agent can act outside the working directory. Treat that tier as
  running an unreviewed program.
- **No approval prompt** before a destructive tool call. An earlier design called
  for one; it is not implemented, and `docs/design.md` §9 says so.
- **Claude's tool gating is a deny-list**, built by subtracting from a hardcoded
  snapshot of tool names. A tool that CLI gains later is not in that list and so is
  not denied.
- **Agent output is not trusted content.** It is rendered as Markdown with HTML
  escaped, but it comes from models that read the web.

## Known advisories

- **`glib` < 0.20 (GHSA-wrw7-89jp-8q8g), moderate.** Reached only through Tauri's
  Linux (GTK) backend. It is not in the macOS dependency graph
  (`cargo tree --target aarch64-apple-darwin -i glib` finds nothing), so the macOS
  app does not contain it, and this project does not build or ship a Linux desktop
  app. Dismissed on that basis; the fix is Tauri moving off gtk-rs 0.18 and will be
  looked at with the Tauri 2.12 upgrade.

## Scope

In scope: anything that lets a website or a remote host reach the API, escalate a
tier, or read the database. Also anything that causes a spend without a human
starting a run.

Out of scope: attacks that require an already-compromised local account, and the
behaviour of the underlying CLIs themselves — report those upstream.
