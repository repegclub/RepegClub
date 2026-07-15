// Internal monitoring script (not exposed anywhere in the frontend): scans a
// Wheel Manager or Weekly Round contract's full round/week history and flags
// any draw that landed suspiciously late in its draw window - the signal for
// "someone may have waited for/chosen a favorable block instead of the
// keeper drawing immediately" (see rand.rs KNOWN LIMITATION comments and the
// 2026-07-14 security review). A healthy keeper-drawn round has gap 0 or 1;
// a large gap alone isn't proof of anything, but a *pattern* of the same
// validator proposing the block, or the same wallet winning, across several
// flagged rounds is worth investigating.
//
// Usage: npx tsx src/checkDrawGrinding.ts <wheel-manager|weekly-round> <contract-address> [min-gap=2]

import { queryContract } from "@goblinhunt/cosmes/client";

import { RPC } from "./config";

const LCD = "https://lcd.terra-classic.hexxagon.dev";

type ContractType = "wheel-manager" | "weekly-round";

type RoundLike = {
  round_id?: number;
  week_id?: number;
  status: string;
  draw_after_height: number | null;
  draw_height: number | null;
  winner: string | null;
};

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

async function resolveProposer(height: number): Promise<{ address: string; moniker: string | null }> {
  const [blockBody, validatorsBody] = await Promise.all([
    fetchJson(`${RPC}/block?height=${height}`),
    fetchJson(`${RPC}/validators?height=${height}&per_page=200`),
  ]);
  const proposerAddress: string = blockBody.result.block.header.proposer_address;
  const validatorEntry = validatorsBody.result.validators.find((v: any) => v.address === proposerAddress);
  if (!validatorEntry) return { address: proposerAddress, moniker: null };

  const stakingBody = await fetchJson(`${LCD}/cosmos/staking/v1beta1/validators?pagination.limit=200`);
  const stakingEntry = stakingBody.validators.find(
    (v: any) => v.consensus_pubkey?.key === validatorEntry.pub_key.value
  );
  return { address: proposerAddress, moniker: stakingEntry?.description?.moniker ?? null };
}

async function loadDrawnRounds(type: ContractType, address: string): Promise<RoundLike[]> {
  const current = await queryContract<any>(RPC, {
    address,
    query: type === "wheel-manager" ? { get_current_round: {} } : { get_current_week: {} },
  });
  const latestId: number = type === "wheel-manager" ? current.round_id : current.week_id;

  const rounds: RoundLike[] = [];
  for (let id = 1; id <= latestId; id++) {
    const round = await queryContract<RoundLike>(RPC, {
      address,
      query:
        type === "wheel-manager" ? { get_round_history: { round_id: id } } : { get_week_history: { week_id: id } },
    });
    rounds.push(round);
  }
  return rounds.filter((r) => r.status === "drawn" && r.draw_height !== null && r.draw_after_height !== null);
}

async function main() {
  const type = process.argv[2] as ContractType;
  const address = process.argv[3];
  const minGap = Number(process.argv[4] ?? 2);

  if ((type !== "wheel-manager" && type !== "weekly-round") || !address) {
    console.error("Usage: tsx src/checkDrawGrinding.ts <wheel-manager|weekly-round> <contract-address> [min-gap=2]");
    process.exit(1);
  }

  console.log(`Scanning ${type} at ${address} for draws with gap > ${minGap} block(s)...\n`);
  const drawn = await loadDrawnRounds(type, address);

  type Flagged = { id: number; gap: number; winner: string; proposerAddress: string; moniker: string | null };
  const flagged: Flagged[] = [];

  for (const round of drawn) {
    const id = (round.round_id ?? round.week_id)!;
    const gap = round.draw_height! - round.draw_after_height!;
    const suspicious = gap > minGap;
    console.log(
      `#${id} | draw_after_height=${round.draw_after_height} | draw_height=${round.draw_height} | gap=${gap}${suspicious ? "  <-- SUSPICIOUS" : ""}`
    );

    if (suspicious) {
      const { address: proposerAddress, moniker } = await resolveProposer(round.draw_height!);
      flagged.push({ id, gap, winner: round.winner!, proposerAddress, moniker });
      console.log(
        `    proposer: ${proposerAddress}${moniker ? ` (${moniker})` : " (moniker not resolved)"} | winner: ${round.winner}`
      );
    }
  }

  console.log(`\n${flagged.length} of ${drawn.length} drawn round(s) exceeded the gap threshold.`);
  if (flagged.length < 2) return;

  const byProposer = new Map<string, Flagged[]>();
  const byWinner = new Map<string, Flagged[]>();
  for (const f of flagged) {
    byProposer.set(f.proposerAddress, [...(byProposer.get(f.proposerAddress) ?? []), f]);
    byWinner.set(f.winner, [...(byWinner.get(f.winner) ?? []), f]);
  }
  for (const [proposer, entries] of byProposer) {
    if (entries.length > 1) {
      console.log(
        `\nPATTERN: proposer ${proposer} proposed the draw block in ${entries.length} flagged rounds: #${entries.map((e) => e.id).join(", #")}`
      );
    }
  }
  for (const [winner, entries] of byWinner) {
    if (entries.length > 1) {
      console.log(`PATTERN: wallet ${winner} won ${entries.length} flagged (late-drawn) rounds: #${entries.map((e) => e.id).join(", #")}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
