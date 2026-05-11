# as-me

Personal scoped GitHub App wrapper. Replaces `gh auth login` (full OAuth) with a GitHub App that only has `contents`, `pull_requests`, `issues`, `metadata`, `statuses` — nothing else. Two modes:

- **as-me** (default): user-to-server token, acts as @mvhenten.
- **as-me bot ...**: installation token, acts as the App; prepends `🧃 created on behalf of @mvhenten` to PR/issue bodies.

Single-user, runs on your laptop, no deps.

## Setup

```sh
git clone <this repo> ~/development/as-me
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
