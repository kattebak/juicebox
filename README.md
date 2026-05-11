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
git clone git@github.com:kattebak/as-me.git ~/development/as-me
cd ~/development/as-me && npm link        # or: ln -s "$PWD/bin/as-me" ~/.local/bin/as-me
as-me init --org stxgroup                 # creates the GitHub App (browser opens)
as-me install --org stxgroup              # installs it on the org
as-me login                               # user-to-server OAuth
```

After `init`, secrets live in `~/.config/as-me/` (mode 0600). The private key is `private-key.pem`.

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

- `bin/as-me` — CLI
- `lib/state.mjs` — `~/.config/as-me/state.json` I/O
- `lib/oauth.mjs` — OAuth + refresh + local callback server
- `lib/jwt.mjs` — RS256 JWT + installation token
- `lib/gh-bot.mjs` — `gh` child process + body-prefix injection
- `manifest.json` — App manifest (permission ceiling)
