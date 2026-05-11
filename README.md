# as-me

Personal scoped GitHub App wrapper. Replaces `gh auth login` (full OAuth) with a GitHub App that only has `contents`, `pull_requests`, `issues`, `metadata`, `statuses` — nothing else. Two modes:

- **as-me** (default): user-to-server token, acts as the authenticated user.
- **as-me bot ...** — a.k.a. **🧃 juicebox** / **on-behalf-of** mode: installation token, acts as the App; prepends `🧃 created on behalf of @<login>` to PR/issue bodies so reviewers and audit can tell an agent (not the human) opened the PR or wrote the comment.

Single-user, runs on your laptop, no deps.

## Why

GitHub's web UI gates destructive admin actions behind sudo-mode prompts, confirmation modals, and "type the repo name to confirm" screens. The API does none of that. A token authenticated as you can modify branch protection, add org members, or delete repos in a single curl — no friction, no second look.

That asymmetry was tolerable when CLI tokens were used by humans typing slowly and reading what they typed. With LLM coding agents, it isn't. An agent's context is porous: an instruction injected via a PR description, a fetched webpage, an issue body, or an MCP tool response becomes an action the agent takes on your behalf. The default `gh auth login` token has the same ceiling as your account, so every prompt-injection bug is also a privilege-escalation bug.

`as-me` replaces that token with one bound to a GitHub App whose permission ceiling is fixed in the manifest. It cannot do administration, cannot manage members, cannot touch Actions, cannot read secrets. The ceiling is set once, in code, and applies to every token the App ever mints. Compromise the agent and the worst case is "it can do everything `as-me` declares" — not "everything you can do."

## Setup

```sh
curl -fsSL https://raw.githubusercontent.com/kattebak/as-me/main/install.sh | bash
```

Defaults install to `~/.local/share/as-me` with `as-me` symlinked into `~/.local/bin`. Override via `AS_ME_HOME=` / `BIN_DIR=` env vars.

```sh
as-me init [--org <name>]                 # creates the GitHub App (manual paste by default)
as-me install [--org <name>]              # installs it on a user or org account
as-me login                               # user-to-server OAuth (device flow)
```

`init` writes a tiny HTML form to `/tmp` and prints its `file://` path. Open it in any browser — your laptop, your phone, an SSH-forwarded session, anywhere — and the form auto-POSTs the manifest to GitHub. After you click "Create GitHub App", the browser will redirect to a `127.0.0.1:8765` URL that fails to load — paste that failed URL (or just the `code=…` value) back at the CLI prompt. `install` works the same way but uses a regular GitHub URL (no form needed). Neither needs an open port, a local browser, or a graphical environment on the machine running `as-me`. If your browser is on a different machine, `scp` the HTML over first — the CLI prints the exact command.

```text
$ as-me init
open this HTML file in any browser:

file:///tmp/as-me-init-XXXX/manifest.html

it auto-submits the manifest to GitHub via POST. on the GitHub page,
scroll to the bottom and click 'Create GitHub App' …

paste: http://127.0.0.1:8765/manifest-callback?code=abc123

app created: https://github.com/settings/apps/mvhenten-only

REQUIRED before `as-me login`:
  1. open https://github.com/settings/apps/mvhenten-only
  2. scroll to 'Identifying and authorizing users'
  3. toggle 'Enable Device Flow' ON, click Save

next: as-me install
```

(GitHub's manifest flow requires POST: a GET URL with `?manifest=…` is silently ignored and you'd see the blank manual-create form. That's why `init` writes an auto-submitting form instead of just printing a URL.)

Omit `--org` to create/install under your own account; pass `--org <name>` to target an org you administer. `init` defaults the App name to `${USER}-only` (e.g. `mvhenten-only`) so each install is single-tenant by convention; pass `--name <slug>` to override, or `--description <text>` for the description shown in GitHub's UI.

After `as-me init`, toggle **Enable Device Flow** in the App's settings page (manifest can't set it, so it's a one-time UI click). Without it, `as-me login` will abort with `device_flow_disabled`.

After `init`, secrets live in `~/.config/as-me/` (mode 0600). The private key is `private-key.pem`.

### Same-host shortcut (`--loopback`)

If your browser and the CLI run on the same host and nothing else holds `127.0.0.1:8765`, `as-me init --loopback` / `as-me install --loopback` will spawn a local listener, try to open the URL for you, and capture the callback automatically (no paste step). The default is manual paste because it works everywhere — loopback is faster when it works but assumes local-port reachability that corporate laptops, SSH-only machines, and locked-down networks often don't allow.

### Remote / headless machines

Manual paste already works headless, so bootstrapping on the remote itself is fine. If you'd rather bootstrap on your laptop and copy the result over, only the state dir needs to move:

```sh
rsync -a ~/.config/as-me/ remote:.config/as-me/
ssh remote as-me login
```

The state dir holds App credentials + PEM (mode 0600); `as-me login` on the remote mints its own user token via device flow.

## Claude Code skill

The canonical skill lives at `skills/as-me/SKILL.md` in this repo — framework-agnostic, so any agent runtime that reads SKILL-style markdown can point at it directly. The installer symlinks it into `~/.claude/skills/as-me/` for Claude Code specifically; in a fresh conversation type `/as-me` and the skill walks the agent through install → init → device-flow toggle reminder → install → login → shell + git wiring → verify, using `as-me status` to figure out where you are. Override the link target with `SKILL_DIR=…` if you keep skills elsewhere; users on other runtimes can ignore the symlink and point their runtime at the in-repo path.

## Daily use

```sh
eval "$(as-me env)"                       # exports GH_TOKEN / GITHUB_TOKEN for this shell
git config --global credential.https://github.com.helper '!as-me git-credential'
```

The credential helper auto-refreshes when the token is within 5 min of expiry.

## Bot mode (a.k.a. 🧃 juicebox / on-behalf-of mode)

```sh
as-me bot pr create --title "x" --body "y"   # body becomes "🧃 created on behalf of @<login>\n\ny"
as-me bot issue comment 123 --body "ack"     # same prefix
```

The 🧃 prefix is the point: anything an agent (or you, deliberately) opens via `as-me bot` is visibly attributed to the App, not to you. Reviewers and audit logs can tell at a glance which PRs/issues/comments were agent-initiated. The colloquial name is "juicebox mode" (from the 🧃) — when you hear "post that on-behalf-of" or "use juicebox", it means this.

Bot picks the installation by reading the current repo's `origin` remote and looking up the owner in state. The juicebox prefix only applies to body-bearing `gh` subcommands (`pr create`, `issue create`, `pr comment`, `issue comment`, `pr review`); all other `gh` calls under `as-me bot` run unchanged with the installation token.

## Security model

The App's manifest declares a permission ceiling (write on contents/PRs/issues/statuses, read on metadata). Users cannot elevate beyond the manifest. No admin, no org-management, no Actions, no packages. Kill switch: uninstall the App from the org (Settings → Integrations) — every token it ever minted dies. The OAuth user token is also scoped to those same permissions because it's a user-to-server token bound to the App.

## Org-side lockdown

`as-me` only closes one side door. The org still allows OAuth-flow `gh` tokens and classic PATs by default, both of which carry your full account power. Close them in `Org → Settings → Third-party Access`:

1. **OAuth application policy → Setup application access restrictions.** Members can no longer connect arbitrary OAuth apps to org resources.
2. **OAuth application policy → Approved OAuth Apps → "GitHub CLI" → Deny.** `gh auth login` (device flow) can no longer touch the org. Anyone wanting `gh` uses `as-me` or an FG-PAT.
3. **Personal access tokens → Tokens (classic) → Restrict access.** Classic PATs are dead against the org. They inherit full account power and have no per-permission scoping, so they're the worst surface.
4. **Personal access tokens → Fine-grained tokens → Require administrator approval.** FG-PATs are fine for one-off human ops but now go through an approval queue.
5. **GitHub Apps → audit installed apps.** Anything with `administration` / `members` write that you don't recognize: uninstall.

After this the only paths in are `as-me` (manifest-bounded), FG-PATs (approval-gated), and explicitly approved GitHub Apps. Migrate load-bearing classic-PAT automations first — flipping step 3 cold will 401 them.

On Enterprise Cloud, lift the same toggles to `Enterprise → Policies → Personal access tokens` and `Enterprise → Policies → OAuth apps` so an org admin can't loosen them later.

## Commands

```
as-me init [--org <name>] [--loopback]      create App from manifest (paste-back by default)
as-me install [--org <name>] [--loopback]   install App, capture installation_id
as-me login                                 user OAuth (refresh-capable, device flow)
as-me env                                   print export lines for eval
as-me git-credential <op>                   git credential helper protocol
as-me bot <gh-args...>                      run gh as the App (🧃 juicebox / on-behalf-of mode)
as-me status                                dump configured state
```

## Files

- `bin/as-me.mjs` — CLI
- `lib/state.mjs` — `~/.config/as-me/state.json` I/O
- `lib/oauth.mjs` — OAuth device flow + refresh + manifest/install callback server
- `lib/jwt.mjs` — RS256 JWT + installation token
- `lib/gh-bot.mjs` — `gh` child process + body-prefix injection
- `manifest.json` — App manifest (permission ceiling)
- `install.sh` — curl-installable bootstrap
- `skills/as-me/SKILL.md` — framework-agnostic agent skill for guided setup
