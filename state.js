import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "fs";
import { join } from "path";

// All runtime files (token, decision log, open position, trades.csv) live in
// STATE_DIR. On Railway, mount a volume there — the container filesystem is
// wiped between cron runs, which would lose track of an open position.
export function statePath(name) {
  const dir = process.env.STATE_DIR || ".";
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, name);
}

export function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8"));
}

// Write-then-rename so a crash mid-write never leaves half a JSON file behind.
export function writeJson(path, data) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}
