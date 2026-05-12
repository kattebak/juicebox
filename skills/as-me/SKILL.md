---
name: as-me
description: Install and set up the `as-me` GitHub App wrapper. Replaces full-privilege OAuth tokens with manifest-scoped App credentials for `git` and `gh`. Use when the user asks to install or configure `as-me`, wants scoped GitHub credentials on this machine, or refers to 🧃 juicebox / on-behalf-of / bot mode (the agent-attribution wrapper around `gh`).
---

End state: `gh` and `git push` use a manifest-scoped App token instead of a full-privilege OAuth token. `as-me status` is the source of truth for where the user is in setup — run it whenever you're unsure which step to drive next.

## 1. Install the CLI

```sh
command -v as-me >/dev/null || curl -fsSL https://raw.githubusercontent.com/kattebak/as-me/main/install.sh | bash
```

If `$HOME/.local/bin` is not on `PATH`, append `export PATH="$HOME/.local/bin:$PATH"` to the rc file matching `$SHELL` (`~/.bashrc` for bash, `~/.zshrc` for zsh) and tell the user to open a new shell before continuing.

## 2. Determine state

Run `as-me status` and parse the output. Map to the next section:

| State                                | Next |
| ------------------------------------ | ---- |
| no app credentials                   | §3   |
| app present, no installation         | §4   |
| installation present, no user token  | §5   |
| user token present, shell not wired  | §6   |
| all wired, token valid               | §7   |

## 3. `as-me init`

Ask which org to create the App under. Default to personal (omit `--org`). The default App name is `${USER}-only` (e.g. `mvhenten-only`) — single-tenant by convention. Override with `--name <slug>` if the user wants a different identity, or `--description <text>` for the App description shown in GitHub's UI.

```sh
as-me init [--org <org>] [--name <slug>] [--description <text>]
```

The CLI prints a URL to `https://kattebak.github.io/as-me/init.html?name=…&org=…` (a hosted setup wizard in this repo's GitHub Pages). Tell the user: open the URL in any browser — laptop, phone, anywhere. The page lets them review/edit the App name and owner, shows exactly which permissions are being granted (locked by the manifest, not editable), and submits to GitHub when they click **Create GitHub App**. GitHub then redirects to `callback.html` which displays a copy-friendly "paste this back" code box.

The user copies the code from the callback page (it also auto-copies to clipboard on load) and pastes it into the still-waiting CLI prompt. The CLI exchanges the code for the App's PEM + client secret and saves them.

**Critical — do this immediately after the App is created, before §5:** open the App's settings page → "Identifying and authorizing users" → toggle **Enable Device Flow** on. The manifest cannot set this flag; without it `as-me login` aborts with `device_flow_disabled`. The exact URL is whatever `as-me init` prints as `app created: …` (also visible later via `as-me status` as `html url`) — don't guess the slug; GitHub appends a suffix when the name is taken.

**Visibility — only matters if the user wants multi-account install:** the wizard defaults to private, meaning the App can only be installed on the owner picked above (single-tenant). If the user wants to install on multiple accounts they own (e.g., personal + an org), they should pick **Public** in the wizard at init time, OR flip it later under *App settings → Advanced → Make public*. Public is safe — each installation is isolated to the installer's chosen repos, the manifest permission ceiling still applies. The CLI accepts `--public` to pre-select Public in the wizard.

## 4. `as-me install`

```sh
as-me install [--org <org>]
```

CLI prints `https://github.com/apps/<slug>/installations/new` directly (no setup wizard needed — GitHub's own install page is fine). **On the GitHub page**, the user picks which repositories the App can access — fewer repos = smaller blast radius; this can be changed later. After clicking Install, GitHub redirects to the same `callback.html` page, which now displays the `installation_id`. User pastes that back into the CLI prompt.

## 5. `as-me login`

```sh
as-me login
```

Device flow. Prints a short user code and a verification URL, then polls GitHub. No local port, works headless / over SSH.

## 6. Wire up shell + git

Both ops must be idempotent — grep before appending, check `git config --get` before setting.

- Shell rc: append `eval "$(as-me env)"` to `~/.bashrc` or `~/.zshrc` (match `$SHELL`) only if not already present.
- Git credential helper:

  ```sh
  git config --global credential.https://github.com.helper '!as-me git-credential'
  ```

  Skip if `git config --get credential.https://github.com.helper` already returns that value.

## 7. Verify

```sh
eval "$(as-me env)" && gh api user --jq '.login'
```

Should print the user's GitHub login. On 401, re-run §5.

## 8. 🧃 Juicebox / on-behalf-of mode

`as-me bot <gh-args…>` runs `gh` with an App installation token instead of the user's token, and prepends `🧃 created on behalf of @<login>` to PR/issue bodies. It's the agent-attribution mode: anyone reading the PR can see at a glance that an agent (not the human) wrote it.

The prefix is injected on body-bearing subcommands: `pr create`, `issue create`, `pr comment`, `issue comment`, `pr review`. All other `gh` calls under `as-me bot` run unchanged with the installation token.

**When to invoke:** only when the user asks, in words like "use juicebox", "post this on-behalf-of", "open it as the bot". Do not switch into bot mode unilaterally — opening a PR as @user vs. as the App is a meaningful authorship choice and the user owns it.

**Routing:** bot mode reads the current repo's `origin` remote, takes the owner from it, and looks up the installation in state. If the owner has no installation, the user needs `as-me install --org <owner>` first.

Example:

```sh
as-me bot pr create --title "fix flake in api tests" --body "small retry tweak"
# body becomes:
#   🧃 created on behalf of @<login>
#
#   small retry tweak
```

**Gotcha — Copilot review rulesets:** if the target repo has a ruleset with *Automatically request Copilot code review* enabled (and a required status check pinned to that flow, e.g. `copilot-review-gate`), do **not** open the PR via `as-me bot`. GitHub's ruleset only fires when the PR author has Copilot entitlement; bot authors are silently skipped, no `review_requested` event is recorded, and the required check stays `pending` forever — `mergeStateStatus` stays `BLOCKED` with otherwise green CI. Fall back to plain `gh pr create` (user identity) — this still uses the `as-me`-scoped user-to-server token from §5/§6, so credentials stay manifest-scoped; only the PR authorship changes from App → user. Recovery for an already-opened bot PR: close it and reopen via plain `gh pr create` — Copilot auto-reviews the reopened PR normally. Requesting Copilot manually via `gh api .../requested_reviewers` or GraphQL `requestReviews` does not work around it (REST silently drops, GraphQL rejects bot IDs).

## Notes

- Never `cat` or print `~/.config/as-me/private-key.pem` or `~/.config/as-me/state.json` — they hold the App private key.
- If the user is an org admin and asks about hardening the org against classic PATs / OAuth `gh`, point them to the **Org-side lockdown** section in the repo's README — only if they ask, and only if it applies to them.
