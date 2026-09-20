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

// Not network-scoped by design (CodeRabbit flagged this as a "heavy lift"
// finding, 2026-09-19 review - considered and deliberately not implemented):
// none of the 3 filename patterns above encode which network they belong
// to, so if a testnet and a mainnet deployment file ever coexisted in the
// same SCRIPTS_DIR, this would discover both and a caller could query a
// testnet address against a mainnet RPC (or vice versa). The real mitigation
// is operational, not code: keeperMainnet.ts/generateAndPushCommitsMainnet.ts
// are meant to run from their own directory on the VM containing only
// mainnet deployment-*.json files (see the Obsidian mainnet deploy plan for
// the VM layout, and Repeg Club - Infraestructura de despliegue for how the
// VM's copy is curated separately from this repo's shared scripts/testnet/
// directory, where both networks' files intentionally coexist for local
// dev convenience). Scoping this in code would mean redesigning every
// target type's filename convention at once, not just weekly-round's -
// not worth that refactor for a risk already closed by how the VM is laid
// out.
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
