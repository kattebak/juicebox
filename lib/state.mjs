import { homedir } from "node:os";
import { join } from "node:path";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  chmodSync,
} from "node:fs";

const DIR = join(homedir(), ".config", "as-me");
const STATE_FILE = join(DIR, "state.json");
const PEM_FILE = join(DIR, "private-key.pem");

function ensureDir() {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true, mode: 0o700 });
  try {
    chmodSync(DIR, 0o700);
  } catch {}
}

export function statePath() {
  return STATE_FILE;
}

export function pemPath() {
  return PEM_FILE;
}

export function loadState() {
  ensureDir();
  if (!existsSync(STATE_FILE)) return { installations: {} };
  const raw = readFileSync(STATE_FILE, "utf8");
  const s = JSON.parse(raw);
  if (!s.installations) s.installations = {};
  return s;
}

export function saveState(state) {
  ensureDir();
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
  try {
    chmodSync(STATE_FILE, 0o600);
  } catch {}
}

export function writePem(pem) {
  ensureDir();
  writeFileSync(PEM_FILE, pem, { mode: 0o600 });
  try {
    chmodSync(PEM_FILE, 0o600);
  } catch {}
}

export function readPem() {
  if (!existsSync(PEM_FILE)) throw new Error(`No private key at ${PEM_FILE}`);
  return readFileSync(PEM_FILE, "utf8");
}
