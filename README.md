# juicebox

## Plugging GitHub's privilege escalation vector

GitHub's web UI gates destructive admin actions behind sudo-mode prompts and confirmation modals. The API does not. A token authenticated as you can modify branch protection, add org members, or delete repos in a single curl.

LLM agents turn that API into a privilege-escalation surface. Anything an agent reads — a PR body, an issue, a fetched page, an MCP tool response — can carry instructions the agent then executes. A default `gh auth login` token carries your full account permissions, so every prompt-injection bug becomes a privilege-escalation bug. The token also has no expiration by default — once exfiltrated, it remains valid indefinitely unless manually revoked. If the agent also assumes an OIDC role in CI, the same risk extends to whatever that role can reach.

## How

`juice-bot` is a scoped GitHub App wrapper for `gh` and `git`. It replaces `gh auth login` (full OAuth) with a GitHub App whose permissions are fixed by the manifest at `contents`, `pull_requests`, `issues`, `metadata`, and `statuses`. Single-user, POSIX `sh`, depends on `curl`, `jq`, `openssl`, `git`, and `gh`. Two modes:

- **juice-bot** (default): user-to-server token, acts as the authenticated user.
- **juice-bot gh ...** — bot / on-behalf-of mode: installation token, acts as the App; prepends `🧃 created on behalf of @<login>` to PR/issue bodies so reviewers and audit logs can identify agent-authored content.

## Setup

```sh
curl -fsSL https://raw.githubusercontent.com/kattebak/juicebox/main/install.sh | bash
```

Defaults install to `~/.local/share/juicebox` with `juice-bot` symlinked into `~/.local/bin`. Override via `JUICEBOX_HOME=` / `BIN_DIR=` env vars.

```sh
juice-bot init [--org <name>]                 # creates the GitHub App (manual paste by default)
juice-bot install [--org <name>]              # installs it on a user or org account
juice-bot login                               # user-to-server OAuth (device flow)
```

`init` prints a URL to a hosted setup wizard at [kattebak.github.io/juicebox/init.html](https://kattebak.github.io/juicebox/init.html). Open it in any browser. The page lets you review the App name and owner, shows the permissions declared by the manifest, and submits to GitHub when you click **Create GitHub App**. GitHub redirects to a callback page that displays a code (also auto-copied to clipboard). Paste it into the CLI's `paste:` prompt. `install` works the same way via GitHub's install page.

The flow requires no open port, no local browser, and no graphical environment on the machine running `juice-bot`. HTTPS end-to-end.

```text
$ juice-bot init
open this URL in any browser to create your scoped GitHub App:

https://kattebak.github.io/juicebox/init.html?name=mvhenten-only

the page is the setup wizard — review the App name/owner, see exactly which
permissions are being granted (locked by manifest), click 'Create GitHub App'.
GitHub will redirect you to a small paste-helper page; copy the code from
there into the prompt below.

paste: ████████████████████████████

app created: https://github.com/settings/apps/mvhenten-only

REQUIRED before `juice-bot login`:
  1. open https://github.com/settings/apps/mvhenten-only
  2. scroll to 'Identifying and authorizing users'
  3. toggle 'Enable Device Flow' ON, click Save

next: juice-bot install
```

Omit `--org` to create/install under your own account; pass `--org <name>` to target an org you administer. `init` defaults the App name to `${USER}-only` (e.g. `mvhenten-only`) so each install is single-tenant by convention; pass `--name <slug>` to override, or `--description <text>` for the description shown in GitHub's UI.

### Private vs public

The wizard defaults the App to **private**: it can only be installed on the account that owns it. To install one App on multiple accounts you own (e.g., personal + an org), pick **Public** in the wizard or pass `--public` to `juice-bot init`. Each installation is still isolated to the installer's chosen repos, and the manifest permissions still apply — "public" only affects who can install, not what an installation can do. You can switch private → public later under *App settings → Advanced → Make public*; the reverse is not possible once another account has installed.

After `init`, secrets live in `~/.config/juicebox/` (mode 0600). The private key is `private-key.pem`.

### Why a hosted page?

GitHub's App-manifest flow requires the manifest to be submitted as the body of a POST to `https://github.com/settings/apps/new`. A GET URL with `?manifest=…` is silently ignored; a local `file://` form requires the browser to be on the same machine as the CLI; a loopback redirect (`http://127.0.0.1:8765/…`) is blocked by many browsers as an HTTPS→HTTP downgrade. A hosted page handles all three.

The page is two static HTML files at `docs/init.html` and `docs/callback.html`, served via GitHub Pages. They take no credentials and run no backend; the wizard builds the manifest JSON from the form fields and submits it to github.com directly.

To avoid depending on `kattebak.github.io` (fork-and-host scenarios, air-gapped networks), fork this repo, enable Pages on your fork, and update `PAGES_BASE` in `bin/juice-bot` to your fork's URL.

### Remote / headless machines

The Pages flow works headless: run `juice-bot init` on the remote, open the URL on your laptop, paste the code back into the SSH session. To bootstrap on your laptop and copy the result over, only the state dir needs to move:

```sh
rsync -a ~/.config/juicebox/ remote:.config/juicebox/
ssh remote juice-bot login
```

The state dir holds App credentials + PEM (mode 0600); `juice-bot login` on the remote mints its own user token via device flow.

## Claude Code skill

The skill is at `skills/juicebox/SKILL.md` and is framework-agnostic; any agent runtime that reads SKILL-style markdown can point at it directly. The installer symlinks it into `~/.claude/skills/juicebox/` for Claude Code. In a fresh conversation, type `/juicebox` and the skill walks the agent through install → init → device-flow toggle → install → login → shell + git wiring → verify, using `juice-bot status` to determine the current step. Override the link target with `SKILL_DIR=…` to use a different location; users on other runtimes can ignore the symlink and point their runtime at the in-repo path.

## Daily use

```sh
eval "$(juice-bot env)"                       # exports GH_TOKEN / GITHUB_TOKEN for this shell
git config --global credential.https://github.com.helper '!juice-bot git-credential'
```

The credential helper auto-refreshes when the token is within 5 min of expiry.

## Bot mode (a.k.a. 🧃 / on-behalf-of mode)

```sh
juice-bot gh pr create --title "x" --body "y"   # body becomes "🧃 created on behalf of @<login>\n\ny"
juice-bot gh issue comment 123 --body "ack"     # same prefix
```

The 🧃 prefix attributes the PR/issue/comment to the App rather than to you. Reviewers and audit logs can identify which PRs/issues/comments were agent-initiated.

Bot mode picks the installation by reading the current repo's `origin` remote and looking up the owner in state. The 🧃 prefix is injected only into body-bearing `gh` subcommands (`pr create`, `issue create`, `pr comment`, `issue comment`, `pr review`); all other `gh` calls under `juice-bot gh` run unchanged with the installation token.

## Security model

The App's manifest declares its maximum permissions (write on contents/PRs/issues/statuses, read on metadata). Users cannot elevate beyond the manifest. No admin, no org-management, no Actions, no packages. Token lifetimes are bounded: installation tokens expire after 1 hour; user-to-server tokens after 8 hours, with a refresh token valid 6 months. The long-lived secret is the App's private key at `~/.config/juicebox/private-key.pem`; rotate it (App settings → Private keys → Generate) on suspected compromise. To revoke entirely: uninstall the App from the org (Settings → Integrations); every minted token becomes invalidated. The OAuth user token is scoped to the same permissions because it is a user-to-server token bound to the App.

## Org-side lockdown

`juice-bot` constrains only one access path. The org still accepts OAuth-flow `gh` tokens and classic PATs by default, both of which carry your full account permissions. Restrict them under `Org → Settings → Third-party Access`:

1. **OAuth application policy → Setup application access restrictions.** Members can no longer connect arbitrary OAuth apps to org resources.
2. **OAuth application policy → Approved OAuth Apps → "GitHub CLI" → Deny.** `gh auth login` (device flow) can no longer access the org. Members use `juice-bot` or an FG-PAT.
3. **Personal access tokens → Tokens (classic) → Restrict access.** Classic PATs are blocked against the org. They carry full account permissions and have no per-permission scoping.
4. **Personal access tokens → Fine-grained tokens → Require administrator approval.** FG-PATs remain available for one-off human operations but require approval.
5. **GitHub Apps → audit installed apps.** Uninstall anything with `administration` or `members` write that you do not recognize.

After this, the remaining access paths are `juice-bot` (manifest-bounded), FG-PATs (approval-gated), and explicitly approved GitHub Apps. Migrate any classic-PAT automation before applying step 3; otherwise it will return 401.

On Enterprise Cloud, set the same controls under `Enterprise → Policies → Personal access tokens` and `Enterprise → Policies → OAuth apps` so an org admin cannot relax them later.

## Commands

```
juice-bot init [--org <name>]                   create App from manifest (hosted wizard + paste-back)
juice-bot install [--org <name>]                install App, capture installation_id
juice-bot login                                 user OAuth (refresh-capable, device flow)
juice-bot env                                   print export lines for eval
juice-bot git-credential <op>                   git credential helper protocol
juice-bot gh <gh-args...>                      run gh as the App (🧃 / on-behalf-of mode)
juice-bot status                                dump configured state
```

## Files

- `bin/juice-bot` — CLI (POSIX `sh` dispatch)
- `lib/state.sh` — `~/.config/juicebox/state.json` I/O (set `JUICEBOX_STATE_DIR` to relocate for tests)
- `lib/oauth.sh` — OAuth device flow + refresh + paste-back code/installation-id prompt
- `lib/jwt.sh` — RS256 JWT (openssl) + installation token
- `lib/gh-bot.sh` — `gh` child process + body-prefix injection
- `manifest.json` — App manifest (permission ceiling)
- `install.sh` — curl-installable bootstrap
- `skills/juicebox/SKILL.md` — framework-agnostic agent skill for guided setup
