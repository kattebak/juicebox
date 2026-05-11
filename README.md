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

`init` prints a URL to a hosted setup wizard at [kattebak.github.io/as-me/init.html](https://kattebak.github.io/as-me/init.html). Open it in any browser — laptop, phone, SSH session, anywhere. The page lets you review/edit the App name and owner, shows the locked permission ceiling, and submits the manifest to GitHub when you click **Create GitHub App**. GitHub redirects to a callback page that displays a copy-friendly "paste this back" code box (it also auto-copies to your clipboard). Paste that into the CLI's still-waiting `paste:` prompt and the App is set up. `install` works the same way: GitHub's install page handles the picker, then redirects to the same callback helper.

The flow doesn't need an open port, a local browser, or a graphical environment on the machine running `as-me`. HTTPS end-to-end, no loopback redirects, no file:// dancing.

```text
$ as-me init
open this URL in any browser to create your scoped GitHub App:

https://kattebak.github.io/as-me/init.html?name=mvhenten-only

the page is the setup wizard — review the App name/owner, see exactly which
permissions are being granted (locked by manifest), click 'Create GitHub App'.
GitHub will redirect you to a small paste-helper page; copy the code from
there into the prompt below.

paste: ████████████████████████████

app created: https://github.com/settings/apps/mvhenten-only

REQUIRED before `as-me login`:
  1. open https://github.com/settings/apps/mvhenten-only
  2. scroll to 'Identifying and authorizing users'
  3. toggle 'Enable Device Flow' ON, click Save

next: as-me install
```

Omit `--org` to create/install under your own account; pass `--org <name>` to target an org you administer. `init` defaults the App name to `${USER}-only` (e.g. `mvhenten-only`) so each install is single-tenant by convention; pass `--name <slug>` to override, or `--description <text>` for the description shown in GitHub's UI.

After `init`, secrets live in `~/.config/as-me/` (mode 0600). The private key is `private-key.pem`.

### Why a hosted page?

GitHub's App-manifest flow requires the manifest to be submitted as the body of a POST to `https://github.com/settings/apps/new`. A GET URL with `?manifest=…` is silently ignored; a local `file://` form works only when your browser is on the same machine as the CLI; and a loopback redirect (`http://127.0.0.1:8765/…`) gets blocked in many browsers as an HTTPS→HTTP downgrade. A small hosted page solves all three problems cleanly.

The page is two static HTML files in this repo at `docs/init.html` and `docs/callback.html`, served via GitHub Pages. They take no credentials and run no backend; the wizard just builds the manifest JSON from the form fields and submits it to github.com directly. Source is auditable; nothing is logged anywhere.

If you'd rather not depend on `kattebak.github.io` (fork-and-host scenarios, air-gapped networks, etc.), fork this repo, enable Pages on your fork, and update `PAGES_BASE` in `bin/as-me.mjs` to your fork's URL.

### Remote / headless machines

The Pages flow already works headless — run `as-me init` on the remote, open the URL on your laptop, paste the code back into the SSH session. If you'd rather bootstrap on your laptop and copy the result over, only the state dir needs to move:

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
as-me init [--org <name>]                   create App from manifest (hosted wizard + paste-back)
as-me install [--org <name>]                install App, capture installation_id
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
