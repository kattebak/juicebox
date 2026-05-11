#!/usr/bin/env node
import { execSync } from "node:child_process";
import {
  loadState,
  saveState,
  statePath,
  pemPath,
  writePem,
  readPem,
} from "../lib/state.mjs";
import {
  promptCallbackUrl,
  refreshIfNeeded,
  startDeviceFlow,
  pollDeviceFlow,
  fetchAuthenticatedLogin,
} from "../lib/oauth.mjs";
import { appJwt, installationToken } from "../lib/jwt.mjs";
import { runGhAsBot } from "../lib/gh-bot.mjs";

const PAGES_BASE = "https://kattebak.github.io/as-me";

const HELP = `as-me — scoped GitHub App wrapper

usage:
  as-me init [--org <name>]      create the GitHub App via manifest flow
  as-me install [--org <name>]   install the App on user or org
  as-me login                    OAuth user-to-server login
  as-me env                      print export GH_TOKEN=... for eval
  as-me git-credential <op>      git credential helper (get/store/erase)
  as-me bot <gh-args...>         run gh with an installation token (as the App)
  as-me status                   show what is configured
  as-me --help                   this help

  init prints a URL to ${PAGES_BASE}/init.html — open it in any browser,
  review/edit the App name + owner, click 'Create GitHub App'. GitHub redirects
  back to a 'paste this' page; copy the code into the still-waiting CLI prompt.

  init defaults the App name to \`\${USER}-only\` (e.g. mvhenten-only) so each
  install is single-tenant by convention. Pass --name <slug> to override, or
  --description <text> for the description shown in GitHub's UI.
`;

function parseFlags(args) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--org") {
      flags.org = args[++i];
    } else if (a === "--bot") {
      flags.bot = true;
    } else if (a === "--name") {
      flags.name = args[++i];
    } else if (a === "--description") {
      flags.description = args[++i];
    } else if (a === "--help" || a === "-h") {
      flags.help = true;
    } else {
      rest.push(a);
    }
  }
  return { flags, rest };
}

async function cmdInit(flags) {
  const state = loadState();
  const url = new URL(`${PAGES_BASE}/init.html`);
  const defaultName = flags.name || (process.env.USER ? `${process.env.USER}-only` : null);
  if (defaultName) url.searchParams.set("name", defaultName);
  if (flags.description) url.searchParams.set("desc", flags.description);
  if (flags.org) url.searchParams.set("org", flags.org);

  console.error("open this URL in any browser to create your scoped GitHub App:\n");
  console.error(url.toString());
  console.error(
    "\nthe page is the setup wizard — review the App name/owner, see exactly which\n" +
      "permissions are being granted (locked by manifest), click 'Create GitHub App'.\n" +
      "GitHub will redirect you to a small paste-helper page; copy the code from\n" +
      "there into the prompt below.\n",
  );
  const { params } = await promptCallbackUrl({
    path: "/as-me/callback.html",
    expectParam: "code",
  });
  if (!params.code) throw new Error("no code in manifest callback");
  const res = await fetch(
    `https://api.github.com/app-manifests/${params.code}/conversions`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "as-me",
      },
    },
  );
  const body = await res.text();
  if (!res.ok) throw new Error(`manifest conversion ${res.status}: ${body}`);
  const app = JSON.parse(body);
  state.app_id = app.id;
  state.slug = app.slug;
  state.client_id = app.client_id;
  state.client_secret = app.client_secret;
  state.webhook_secret = app.webhook_secret;
  state.html_url = app.html_url;
  if (app.pem) writePem(app.pem);
  saveState(state);
  console.error(`\napp created: ${app.html_url}\n`);
  console.error("REQUIRED before `as-me login`:");
  console.error(`  1. open ${app.html_url}`);
  console.error("  2. scroll to 'Identifying and authorizing users'");
  console.error("  3. toggle 'Enable Device Flow' ON, click Save");
  console.error("  (the manifest can't set this; login aborts without it)\n");
  console.error(`next: as-me install${flags.org ? ` --org ${flags.org}` : ""}`);
}

async function cmdInstall(flags) {
  const state = loadState();
  if (!state.slug) throw new Error("no app configured; run `as-me init` first");
  const url = `https://github.com/apps/${state.slug}/installations/new`;
  console.error("open this URL in any browser to install the App:\n");
  console.error(url);
  console.error(
    "\non the GitHub page: pick which repositories the App can access. fewer\n" +
      "repos = smaller juicebox = smaller blast radius if anything goes wrong.\n" +
      "you can change this later in the App settings. click Install when done.\n" +
      "GitHub will redirect to a paste-helper page; copy the installation id\n" +
      "from there into the prompt below.\n",
  );
  const { params } = await promptCallbackUrl({
    path: "/as-me/callback.html",
    expectParam: "installation_id",
  });
  const id = params.installation_id;
  if (!id) throw new Error(`no installation_id in callback: ${JSON.stringify(params)}`);
  const installationId = Number.parseInt(id, 10);
  const owner = flags.org || (await resolveInstallationOwner(state, installationId));
  state.installations[owner] = installationId;
  saveState(state);
  console.error(`installed: ${owner} -> ${installationId}`);
}

async function resolveInstallationOwner(state, installationId) {
  if (!state.app_id) throw new Error("no app configured; run `as-me init` first");
  const pem = readPem();
  const jwt = appJwt(state.app_id, pem);
  const res = await fetch(
    `https://api.github.com/app/installations/${installationId}`,
    {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "as-me",
      },
    },
  );
  if (!res.ok)
    throw new Error(`GET /app/installations/${installationId} failed ${res.status}`);
  const json = await res.json();
  if (!json.account?.login)
    throw new Error(`installation ${installationId} has no account.login`);
  return json.account.login;
}

async function cmdLogin() {
  const state = loadState();
  if (!state.client_id)
    throw new Error("no app configured; run `as-me init` first");
  let device;
  try {
    device = await startDeviceFlow(state.client_id);
  } catch (e) {
    if (e.code === "device_flow_disabled") {
      throw new Error(
        `Enable 'Device Flow' in your App's settings at https://github.com/settings/apps/${state.slug} and re-run \`as-me login\`.`,
      );
    }
    throw e;
  }
  const baseUrl = device.verification_uri || "https://github.com/login/device";
  const fullUrl = `${baseUrl}?user_code=${encodeURIComponent(device.user_code)}`;
  const mins = Math.floor(device.expires_in / 60);
  console.error(`open this URL to authorize as-me (code ${device.user_code}, expires in ${mins}m):\n`);
  console.error(`  ${fullUrl}\n`);
  console.error("the code is pre-filled via the URL — just click 'Continue', then 'Authorize'.");
  console.error("waiting...");
  try {
    await pollDeviceFlow(state, device.device_code, device.interval || 5, device.expires_in);
    try {
      state.login = await fetchAuthenticatedLogin(state.access_token);
      saveState(state);
      console.error(`\nlogged in as @${state.login}.`);
    } catch (e) {
      console.error(`\nlogged in (warning: could not fetch user login: ${e.message}).`);
    }
  } catch (e) {
    if (e.code === "expired_token") {
      throw new Error("device code expired; re-run `as-me login`");
    }
    if (e.code === "access_denied") {
      throw new Error("authorization denied");
    }
    if (e.code === "device_flow_disabled") {
      throw new Error(
        `Enable 'Device Flow' in your App's settings at https://github.com/settings/apps/${state.slug} and re-run \`as-me login\`.`,
      );
    }
    throw e;
  }
}

async function cmdEnv() {
  const state = loadState();
  const token = await refreshIfNeeded(state);
  process.stdout.write(
    `export GH_TOKEN=${token}\nexport GITHUB_TOKEN=${token}\n`,
  );
}

async function cmdGitCredential(op) {
  if (op !== "get") {
    process.exit(0);
  }
  // read key=value lines from stdin until blank
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const input = Buffer.concat(chunks).toString("utf8");
  const fields = {};
  for (const line of input.split("\n")) {
    const idx = line.indexOf("=");
    if (idx > 0) fields[line.slice(0, idx)] = line.slice(idx + 1);
  }
  if (fields.host && fields.host !== "github.com") {
    // not our host; print nothing
    return;
  }
  const state = loadState();
  const token = await refreshIfNeeded(state);
  process.stdout.write(`username=x-access-token\npassword=${token}\n\n`);
}

function gitRemoteOwner() {
  const out = execSync("git config --get remote.origin.url", {
    encoding: "utf8",
  }).trim();
  // Handle SSH (git@github.com:owner/repo.git) and HTTPS
  let m = out.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/);
  if (!m) throw new Error(`could not parse remote: ${out}`);
  return m[1];
}

async function cmdBot(args) {
  const state = loadState();
  if (!state.app_id) throw new Error("no app; run `as-me init`");
  let owner;
  try {
    owner = gitRemoteOwner();
  } catch (e) {
    throw new Error(
      `bot mode needs a git repo with origin remote: ${e.message}`,
    );
  }
  const installationId = state.installations[owner];
  if (!installationId)
    throw new Error(
      `no installation for ${owner}; run \`as-me install --org ${owner}\``,
    );
  const pem = readPem();
  const { token } = await installationToken(state.app_id, pem, installationId);
  const code = await runGhAsBot(args, token, state.login);
  process.exit(code);
}

function cmdStatus() {
  const state = loadState();
  const now = Math.floor(Date.now() / 1000);
  const fmt = (t) =>
    t ? `${new Date(t * 1000).toISOString()} (${t - now}s)` : "—";
  console.log(`state file:    ${statePath()}`);
  console.log(`pem file:      ${pemPath()}`);
  console.log(`app id:        ${state.app_id || "—"}`);
  console.log(`slug:          ${state.slug || "—"}`);
  console.log(`html url:      ${state.html_url || "—"}`);
  console.log(`login:         ${state.login ? `@${state.login}` : "—"}`);
  console.log(`client id:     ${state.client_id || "—"}`);
  console.log(
    `installations: ${
      Object.keys(state.installations).length
        ? JSON.stringify(state.installations)
        : "—"
    }`,
  );
  console.log(`access token:  ${state.access_token ? "set" : "—"}`);
  console.log(`  expires:     ${fmt(state.expires_at)}`);
  console.log(`  refresh exp: ${fmt(state.refresh_token_expires_at)}`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(HELP);
    return;
  }
  const sub = argv[0];
  const rest = argv.slice(1);
  const { flags, rest: positional } = parseFlags(rest);
  if (flags.help) {
    process.stdout.write(HELP);
    return;
  }
  switch (sub) {
    case "init":
      return cmdInit(flags);
    case "install":
      return cmdInstall(flags);
    case "login":
      return cmdLogin();
    case "env":
      return cmdEnv();
    case "git-credential":
      return cmdGitCredential(positional[0]);
    case "bot":
      return cmdBot(positional);
    case "status":
      return cmdStatus();
    default:
      process.stderr.write(`unknown command: ${sub}\n\n${HELP}`);
      process.exit(2);
  }
}

main().catch((e) => {
  process.stderr.write(`error: ${e.message}\n`);
  process.exit(1);
});
