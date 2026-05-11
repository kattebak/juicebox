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

**Critical — surface this to the user before they leave the browser callback:** open `https://github.com/settings/apps/as-me` → "Identifying and authorizing users" → toggle **Enable Device Flow** on. The manifest cannot set this flag; without it `as-me login` aborts with `device_flow_disabled`.

**Headless / remote caveat:** if no browser is available on this machine, §3 and §4 can't complete here. Have the user run them on their laptop, then:

```sh
rsync -a ~/.config/as-me/ remote:.config/as-me/
```

and resume from §5 on the remote.

## 4. `as-me install`

```sh
as-me install [--org <org>]
```

Browser opens; the user picks which repos the App can access; the callback captures `installation_id`.

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

## Notes

- Never `cat` or print `~/.config/as-me/private-key.pem` or `~/.config/as-me/state.json` — they hold the App private key.
- Bot mode (`as-me bot <gh-args>`) — a.k.a. **🧃 juicebox** / **on-behalf-of** mode — runs `gh` as the App and prepends `🧃 created on behalf of @<user>` to PR/issue bodies, signalling to reviewers that the action came from an agent. User-invoked: don't switch into it unilaterally. If a user says "use juicebox" / "post that on-behalf-of", they mean `as-me bot`.
- If the user is an org admin and asks about hardening the org against classic PATs / OAuth `gh`, point them to the **Org-side lockdown** section in the repo's README — only if they ask, and only if it applies to them.
