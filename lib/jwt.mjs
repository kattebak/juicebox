import { createSign } from "node:crypto";

function b64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function appJwt(appId, pem) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: now - 60, exp: now + 540, iss: String(appId) };
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const sig = signer.sign(pem);
  return `${unsigned}.${b64url(sig)}`;
}

export async function installationToken(appId, pem, installationId) {
  const jwt = appJwt(appId, pem);
  const res = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "as-me",
      },
    },
  );
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`installation token failed ${res.status}: ${text}`);
  }
  const json = JSON.parse(text);
  return json; // { token, expires_at, ... }
}
