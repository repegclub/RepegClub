// Shared deployment-file discovery for keeper.ts and generateAndPushCommits.ts -
// both need the exact same list of live contract instances, so this is
// factored out rather than duplicated (keeper.ts can't be imported directly
// for this: its module body kicks off an infinite poll loop on import).

import { readFileSync, readdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SCRIPTS_DIR = path.resolve(__dirname, "..");

export type Target =
  | { type: "wheel-manager"; label: string; address: string }
  | { type: "weekly-round"; label: string; address: string }
  | { type: "cyol-factory"; label: string; address: string };

export function discoverTargets(): Target[] {
  const targets: Target[] = [];
  for (const file of readdirSync(SCRIPTS_DIR)) {
    const wheelMatch = file.match(/^deployment-wheelmanager-(.+)\.json$/);
    if (wheelMatch) {
      const { contractAddress } = JSON.parse(readFileSync(path.join(SCRIPTS_DIR, file), "utf8"));
      targets.push({ type: "wheel-manager", label: wheelMatch[1], address: contractAddress });
    }
    // Two possible exact filenames, not one: testnet's fixed name
    // (deployment-weekly-round.json) and mainnet's own
    // (deployment-weekly-round-mainnet.json, deliberately different so
    // deployWeeklyRoundMainnet.ts never overwrites testnet's file when both
    // live in the same directory - see that file's own comment). Missing
    // either one here means the matching keeper/commit-generator process
    // never discovers its Weekly Round contract at all.
    if (file === "deployment-weekly-round.json" || file === "deployment-weekly-round-mainnet.json") {
      const { contractAddress } = JSON.parse(readFileSync(path.join(SCRIPTS_DIR, file), "utf8"));
      targets.push({ type: "weekly-round", label: "weekly-round", address: contractAddress });
    }
    const cyolFactoryMatch = file.match(/^deployment-cyol-factory-(.+)\.json$/);
    if (cyolFactoryMatch) {
      const { contractAddress } = JSON.parse(readFileSync(path.join(SCRIPTS_DIR, file), "utf8"));
      targets.push({ type: "cyol-factory", label: cyolFactoryMatch[1], address: contractAddress });
    }
  }
  return targets;
}
