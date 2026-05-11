import { spawn } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PREFIX = "🧃 created on behalf of @mvhenten";

const BODY_COMMANDS = new Set([
  "pr:create",
  "issue:create",
  "pr:comment",
  "issue:comment",
  "pr:review",
]);

const CREATE_COMMANDS = new Set(["pr:create", "issue:create"]);

function shouldInjectBody(args) {
  if (args.length < 2) return { inject: false };
  const key = `${args[0]}:${args[1]}`;
  if (!BODY_COMMANDS.has(key)) return { inject: false };
  return { inject: true, key, isCreate: CREATE_COMMANDS.has(key) };
}

function rewriteArgs(args, key) {
  const out = [...args];
  let bodyIdx = -1;
  let bodyFileIdx = -1;
  for (let i = 0; i < out.length; i++) {
    if (out[i] === "--body" || out[i] === "-b") bodyIdx = i;
    if (out[i] === "--body-file" || out[i] === "-F") bodyFileIdx = i;
  }

  if (bodyIdx !== -1 && out[bodyIdx + 1] !== undefined) {
    out[bodyIdx + 1] = `${PREFIX}\n\n${out[bodyIdx + 1]}`;
    return out;
  }
  if (bodyFileIdx !== -1 && out[bodyFileIdx + 1] !== undefined) {
    const path = out[bodyFileIdx + 1];
    const orig = readFileSync(path, "utf8");
    const dir = mkdtempSync(join(tmpdir(), "as-me-body-"));
    const tmp = join(dir, "body.md");
    writeFileSync(tmp, `${PREFIX}\n\n${orig}`);
    out[bodyFileIdx + 1] = tmp;
    return out;
  }
  if (CREATE_COMMANDS.has(key)) {
    out.push("--body", PREFIX);
    return out;
  }
  // comment/review without body: leave it, gh will error if it requires one
  return out;
}

export function runGhAsBot(args, token) {
  const { inject, key } = shouldInjectBody(args);
  const finalArgs = inject ? rewriteArgs(args, key) : args;
  const child = spawn("gh", finalArgs, {
    stdio: "inherit",
    env: { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token },
  });
  return new Promise((resolve) => {
    child.on("exit", (code) => resolve(code ?? 0));
  });
}
