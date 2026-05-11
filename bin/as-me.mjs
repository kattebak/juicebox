#!/usr/bin/env node
import { spawn, execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadState,
  saveState,
  statePath,
  pemPath,
  writePem,
  readPem,
} from "../lib/state.mjs";
import {
  runCallbackServer,
  promptCallbackUrl,
  refreshIfNeeded,
  startDeviceFlow,
  pollDeviceFlow,
  fetchAuthenticatedLogin,
} from "../lib/oauth.mjs";
import { appJwt, installationToken } from "../lib/jwt.mjs";
import { runGhAsBot } from "../lib/gh-bot.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

const HELP = `as-me — scoped GitHub App wrapper

usage:
  as-me init [--org <name>] [--loopback]     create the GitHub App via manifest flow
  as-me install [--org <name>] [--loopback]  install the App on user or org
  as-me login                                OAuth user-to-server login
  as-me env                                  print export GH_TOKEN=... for eval
  as-me git-credential <op>                  git credential helper (get/store/erase)
  as-me bot <gh-args...>                     run gh with an installation token (as the App)
  as-me status                               show what is configured
  as-me --help                               this help

  init/install default to manual paste: open the URL in any browser, click
  through the flow, then paste the redirect URL (or the \`code\`/\`installation_id\`
  value from it) back here. Pass --loopback to instead run a local listener on
  127.0.0.1:8765 and auto-receive the callback (only works when the browser
  and the CLI are on the same host and the port is reachable).

  init defaults the App name to \`\${USER}-only\` (e.g. mvhenten-only) so each
  install is single-tenant by convention. Pass --name <slug> to override, or
  --description <text> for the App description shown in GitHub's UI.
`;

function openBrowser(url) {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  try {
    spawn(cmd, [url], { stdio: "ignore", detached: true }).unref();
  } catch {}
  console.error(`open: ${url}`);
}

function parseFlags(args) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--org") {
      flags.org = args[++i];
    } else if (a === "--bot") {
      flags.bot = true;
    } else if (a === "--loopback") {
      flags.loopback = true;
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
  const manifest = JSON.parse(
    readFileSync(join(REPO_ROOT, "manifest.json"), "utf8"),
  );
  if (flags.name) {
    manifest.name = flags.name;
  } else if (process.env.USER) {
    manifest.name = `${process.env.USER}-only`;
  }
  if (flags.description) manifest.description = flags.description;
  const state = loadState();
  const base = flags.org
    ? `https://github.com/organizations/${flags.org}/settings/apps/new`
    : `https://github.com/settings/apps/new`;
  const url = `${base}?manifest=${encodeURIComponent(JSON.stringify(manifest))}`;
  let params;
  if (flags.loopback) {
    console.error("opening browser to create GitHub App from manifest…");
    openBrowser(url);
    ({ params } = await runCallbackServer({
      path: "/manifest-callback",
      port: 8765,
    }));
  } else {
    console.error("open this URL in any browser:\n");
    console.error(url);
    console.error(
      "\non the GitHub page: the manifest pre-fills everything (name, description,\n" +
        "permissions). scroll to the bottom and click 'Create GitHub App'. don't\n" +
        "edit any fields. permissions granted: contents/PRs/issues/statuses write,\n" +
        "metadata read — nothing else. that's the whole juicebox.\n",
    );
    ({ params } = await promptCallbackUrl({
      path: "/manifest-callback",
      expectParam: "code",
    }));
  }
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
  let params;
  if (flags.loopback) {
    console.error("opening browser to install app…");
    openBrowser(url);
    ({ params } = await runCallbackServer({
      path: ["/callback", "/manifest-callback"],
      port: 8765,
    }));
  } else {
    console.error("open this URL in any browser:\n");
    console.error(url);
    console.error(
      "\non the GitHub page: pick which repositories the App can access. fewer\n" +
        "repos = smaller juicebox = smaller blast radius if anything goes wrong.\n" +
        "you can change this later in the App settings. click Install when done.\n",
    );
    ({ params } = await promptCallbackUrl({
      path: ["/callback", "/manifest-callback"],
      expectParam: "installation_id",
    }));
  }
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
  const verifyUrl = device.verification_uri || "https://github.com/login/device";
  const mins = Math.floor(device.expires_in / 60);
  const line = `Open ${verifyUrl} and enter code: ${device.user_code}  (waiting for authorization, expires in ${mins}m...)`;
  process.stdout.write(line);
  const tick = setInterval(() => {
    process.stdout.write(`\r${line}`);
  }, 5000);
  try {
    await pollDeviceFlow(state, device.device_code, device.interval || 5, device.expires_in);
    clearInterval(tick);
    process.stdout.write("\n");
    try {
      state.login = await fetchAuthenticatedLogin(state.access_token);
      saveState(state);
      console.error(`logged in as @${state.login}.`);
    } catch (e) {
      console.error(`logged in (warning: could not fetch user login: ${e.message}).`);
    }
  } catch (e) {
    clearInterval(tick);
    process.stdout.write("\n");
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
