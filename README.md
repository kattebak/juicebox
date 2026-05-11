# as-me

Personal scoped GitHub App wrapper. Replaces `gh auth login` (full OAuth) with a GitHub App that only has `contents`, `pull_requests`, `issues`, `metadata`, `statuses` — nothing else. Two modes:

- **as-me** (default): user-to-server token, acts as @mvhenten.
- **as-me bot ...**: installation token, acts as the App; prepends `🧃 created on behalf of @mvhenten` to PR/issue bodies.

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
as-me init --org stxgroup                 # creates the GitHub App (browser opens)
as-me install --org stxgroup              # installs it on the org
as-me login                               # user-to-server OAuth (device flow)
```

After `as-me init`, toggle **Enable Device Flow** in the App's settings page (manifest can't set it, so it's a one-time UI click). Without it, `as-me login` will abort with `device_flow_disabled`.

After `init`, secrets live in `~/.config/as-me/` (mode 0600). The private key is `private-key.pem`.

## Headless / remote workspaces

`as-me login` uses the OAuth device flow — it prints a short user code and a verification URL, then polls GitHub. Nothing binds to a local port, so it works over SSH with no local browser.

`as-me init` and `as-me install` still open a browser (one-time bootstrap, and the manifest callback needs a loopback redirect). Easiest path: run them on your laptop, then copy the resulting state to the remote:

```sh
rsync -a ~/.config/as-me/ remote:.config/as-me/
ssh remote as-me login
```

The state directory holds the App credentials and PEM (mode 0600); the device-flow login on the remote mints its own user token.

## Claude Code skill

The canonical skill lives at `skills/as-me/SKILL.md` in this repo — framework-agnostic, so any agent runtime that reads SKILL-style markdown can point at it directly. The installer symlinks it into `~/.claude/skills/as-me/` for Claude Code specifically; in a fresh conversation type `/as-me` and the skill walks the agent through install → init → device-flow toggle reminder → install → login → shell + git wiring → verify, using `as-me status` to figure out where you are. Override the link target with `SKILL_DIR=…` if you keep skills elsewhere; users on other runtimes can ignore the symlink and point their runtime at the in-repo path.

## Daily use

```sh
eval "$(as-me env)"                       # exports GH_TOKEN / GITHUB_TOKEN for this shell
git config --global credential.https://github.com.helper '!as-me git-credential'
```

The credential helper auto-refreshes when the token is within 5 min of expiry.

## Bot mode

```sh
as-me bot pr create --title "x" --body "y"   # body becomes "🧃 created on behalf of @mvhenten\n\ny"
as-me bot issue comment 123 --body "ack"     # same prefix
```

Bot picks the installation by reading the current repo's `origin` remote and looking up the owner in state.

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
as-me init [--org <name>]        create App from manifest
as-me install [--org <name>]     install App, capture installation_id
as-me login                      user OAuth (refresh-capable)
as-me env                        print export lines for eval
as-me git-credential <op>        git credential helper protocol
as-me bot <gh-args...>           run gh as the App
as-me status                     dump configured state
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
