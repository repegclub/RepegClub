// Local store for preimages generated offline by generateAndPushCommits.ts,
// consumed by keeper.ts at reveal time. Flat map keyed by the commit hash
// (sha256(preimage), lowercase hex) - a single file works across every
// target because commits are never reused across the project's independent
// queues (see wheel-manager's `execute_push_commits` doc comment), so a
// commit hash is a globally unique lookup key on its own.
//
// This file holds secret material for not-yet-revealed rounds/weeks/raffles
// and must never be committed to git (see scripts/testnet/.gitignore) or
// copied anywhere except this machine and the keeper's own host.

import { existsSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SECRETS_FILE = path.resolve(__dirname, "../keeper-secrets.json");

type SecretsStore = Record<string, string>; // commit hex (lowercase) -> preimage hex

function load(): SecretsStore {
  if (!existsSync(SECRETS_FILE)) return {};
  return JSON.parse(readFileSync(SECRETS_FILE, "utf8"));
}

function save(store: SecretsStore) {
  writeFileSync(SECRETS_FILE, JSON.stringify(store, null, 2));
}

export function addSecrets(pairs: { commit: string; preimage: string }[]) {
  const store = load();
  for (const { commit, preimage } of pairs) {
    store[commit.toLowerCase()] = preimage;
  }
  save(store);
}

/** Preimage for a commit hash, or `undefined` if this keeper never received it. */
export function findPreimage(commitHex: string): string | undefined {
  return load()[commitHex.toLowerCase()];
}

/** Called after a successful RevealDraw - the preimage is public on-chain now, no reason to keep it locally. */
export function consumeSecret(commitHex: string) {
  const store = load();
  delete store[commitHex.toLowerCase()];
  save(store);
}

export function secretCount(): number {
  return Object.keys(load()).length;
}
