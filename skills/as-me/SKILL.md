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

Ask which org to create the App under. Default to personal (omit `--org`). Run:

```sh
as-me init [--org <org>]
```

The CLI prints a `https://github.com/.../settings/apps/new?manifest=…` URL and waits. Tell the user: open it in any browser (laptop, phone, whatever), click **Create GitHub App**. The browser will redirect to a `127.0.0.1:8765` URL that fails to load — that's expected. Copy the full URL from the address bar (or just the `code=…` value) and paste it into the CLI prompt. The CLI exchanges the code with GitHub and saves the App credentials.

**Critical — do this immediately after the App is created, before §5:** open the App's settings page → "Identifying and authorizing users" → toggle **Enable Device Flow** on. The manifest cannot set this flag; without it `as-me login` aborts with `device_flow_disabled`. The exact URL is whatever `as-me init` prints as `app created: …` (also visible later via `as-me status` as `html url`) — don't guess the slug; GitHub appends a suffix when the name is taken.

**Same-host shortcut:** if the user is on a graphical machine where `127.0.0.1:8765` is reachable from their browser, `as-me init --loopback` runs a local listener and auto-captures the callback (no paste). Skip the flag if unsure — the default works in every environment.

## 4. `as-me install`

```sh
as-me install [--org <org>]
```

Same shape as §3: CLI prints a `https://github.com/apps/<slug>/installations/new` URL, user opens it in a browser, picks which repos the App can access, then pastes the redirect URL (containing `installation_id=…`) back. `--loopback` works here too.

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

## Notes

- Never `cat` or print `~/.config/as-me/private-key.pem` or `~/.config/as-me/state.json` — they hold the App private key.
- If the user is an org admin and asks about hardening the org against classic PATs / OAuth `gh`, point them to the **Org-side lockdown** section in the repo's README — only if they ask, and only if it applies to them.
