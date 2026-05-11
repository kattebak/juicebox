import { createServer } from "node:http";
import { URL } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { saveState } from "./state.mjs";

export async function promptCallbackUrl({ path, expectParam }) {
  const paths = Array.isArray(path) ? path : [path];
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    process.stderr.write(
      "\nmanual mode: complete the flow in any browser.\n" +
        `when GitHub redirects to 127.0.0.1:8765 (page will fail to load), copy the full URL\n` +
        `from the address bar and paste below — or just the \`${expectParam}=…\` value.\n\n`,
    );
    const input = (await rl.question("paste: ")).trim();
    if (!input) throw new Error("empty input");
    let pathname = paths[0];
    let params;
    try {
      const u = new URL(input);
      pathname = u.pathname;
      params = Object.fromEntries(u.searchParams.entries());
    } catch {
      params = { [expectParam]: input };
    }
    if (!paths.includes(pathname)) {
      process.stderr.write(
        `note: pathname \`${pathname}\` not in ${JSON.stringify(paths)} — proceeding anyway\n`,
      );
    }
    if (!params[expectParam]) {
      throw new Error(`no ${expectParam} in pasted input`);
    }
    return { pathname, params };
  } finally {
    rl.close();
  }
}

export function runCallbackServer({ path, port = 8765, timeoutMs = 300000 }) {
  return new Promise((resolve, reject) => {
    const paths = Array.isArray(path) ? path : [path];
    const server = createServer((req, res) => {
      const u = new URL(req.url, `http://127.0.0.1:${port}`);
      if (!paths.includes(u.pathname)) {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      const params = Object.fromEntries(u.searchParams.entries());
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        `<!doctype html><meta charset=utf-8><title>as-me</title>` +
          `<body style="font-family:sans-serif;padding:2rem"><h1>as-me</h1>` +
          `<p>Got it. You can close this tab.</p></body>`,
      );
      server.close();
      resolve({ pathname: u.pathname, params });
    });
    server.on("error", reject);
    server.listen(port, "127.0.0.1");
    setTimeout(() => {
      server.close();
      reject(new Error(`callback timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
}

async function postForm(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "as-me",
    },
    body: new URLSearchParams(body).toString(),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`non-JSON from ${url}: ${text}`);
  }
  if (json.error)
    throw new Error(`${json.error}: ${json.error_description || ""}`);
  return json;
}

export async function exchangeCode(state, code) {
  const json = await postForm("https://github.com/login/oauth/access_token", {
    client_id: state.client_id,
    client_secret: state.client_secret,
    code,
  });
  applyTokenResponse(state, json);
  saveState(state);
  return state;
}

export async function startDeviceFlow(clientId) {
  const res = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "as-me",
    },
    body: new URLSearchParams({ client_id: clientId }).toString(),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`non-JSON from device/code: ${text}`);
  }
  if (json.error) {
    const err = new Error(`${json.error}: ${json.error_description || ""}`);
    err.code = json.error;
    throw err;
  }
  return json;
}

export async function pollDeviceFlow(state, deviceCode, interval, expiresIn) {
  const deadline = Date.now() + expiresIn * 1000;
  let wait = interval;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, wait * 1000));
    const res = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "as-me",
      },
      body: new URLSearchParams({
        client_id: state.client_id,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }).toString(),
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`non-JSON from access_token: ${text}`);
    }
    if (json.error === "authorization_pending") continue;
    if (json.error === "slow_down") {
      wait += 5;
      continue;
    }
    if (json.error) {
      const err = new Error(`${json.error}: ${json.error_description || ""}`);
      err.code = json.error;
      throw err;
    }
    applyTokenResponse(state, json);
    saveState(state);
    return state;
  }
  const err = new Error("device flow expired before authorization");
  err.code = "expired_token";
  throw err;
}

export async function fetchAuthenticatedLogin(token) {
  const res = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "as-me",
    },
  });
  if (!res.ok) throw new Error(`GET /user failed ${res.status}`);
  const json = await res.json();
  return json.login;
}

export async function refreshIfNeeded(state) {
  if (!state.access_token) throw new Error("not logged in; run `as-me login`");
  const now = Math.floor(Date.now() / 1000);
  const fiveMin = 5 * 60;
  if (state.expires_at && state.expires_at - now > fiveMin) {
    return state.access_token;
  }
  if (!state.refresh_token)
    throw new Error("token expired and no refresh token; run `as-me login`");
  if (state.refresh_token_expires_at && state.refresh_token_expires_at < now) {
    throw new Error("refresh token expired; run `as-me login`");
  }
  const json = await postForm("https://github.com/login/oauth/access_token", {
    client_id: state.client_id,
    client_secret: state.client_secret,
    grant_type: "refresh_token",
    refresh_token: state.refresh_token,
  });
  applyTokenResponse(state, json);
  saveState(state);
  return state.access_token;
}

function applyTokenResponse(state, json) {
  const now = Math.floor(Date.now() / 1000);
  state.access_token = json.access_token;
  if (json.refresh_token) state.refresh_token = json.refresh_token;
  if (json.expires_in)
    state.expires_at = now + Number.parseInt(json.expires_in, 10);
  if (json.refresh_token_expires_in)
    state.refresh_token_expires_at =
      now + Number.parseInt(json.refresh_token_expires_in, 10);
}
