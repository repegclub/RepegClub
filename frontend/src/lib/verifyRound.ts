import { LCD, RPC } from "./chainConfig";
import { WHEEL_MANAGER_ADDRESS } from "./deployment";
import { getRoundEntrants, getRoundHistory } from "./queryWheelManager";

export type VerifyRoundResult = {
  roundId: number;
  drawHeight: number;
  // How many blocks after the round became eligible to draw it was actually
  // drawn. A healthy, promptly-acting keeper produces 0-2; a much larger gap
  // means whoever drew waited through several blocks first - not proof of
  // anything by itself (shown as plain fact, not an accusation), but the
  // signal worth watching for a pattern across rounds.
  drawAfterHeight: number;
  drawGap: number;
  blockTimeIso: string;
  entrants: string[];
  digestHex: string;
  winnerIndex: number;
  computedWinner: string;
  onChainWinner: string;
  matches: boolean;
  // Plain, independently-fetchable sources for the two raw inputs - a
  // technical reader (or an AI asked to double-check) can hit these directly
  // and redo everything below without trusting this app's own computation.
  blockQueryUrl: string;
  entrantsQueryUrl: string;
};

// Mirrors contracts/wheel-manager/src/rand.rs::pick_winner_index exactly:
// SHA-256(round_id BE u64 | draw block height BE u64 | draw block time in
// nanoseconds BE u64 | for each entrant: utf8 address bytes + 0x00), then
// the first 8 bytes of the digest (BE) modulo the entrant count picks the
// winning index. draw_height/drawn_at alone (from the contract's own query)
// aren't enough to redo this - the query only stores whole-second precision,
// but the hash needs full nanosecond precision - so this fetches the actual
// historical block from the chain's RPC to get the real, exact time used.
function u64BigEndian(n: bigint): Uint8Array {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setBigUint64(0, n, false);
  return new Uint8Array(buf);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function isoToNanos(iso: string): bigint {
  const match = iso.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.(\d+))?Z$/);
  if (!match) throw new Error(`Unexpected block time format: ${iso}`);
  const wholeSeconds = BigInt(Math.floor(new Date(`${match[1]}Z`).getTime() / 1000));
  const fractionNanos = (match[3] ?? "").padEnd(9, "0").slice(0, 9);
  return wholeSeconds * 1_000_000_000n + BigInt(fractionNanos);
}

function entrantsQueryUrl(roundId: number, contractAddress: string): string {
  const query = btoa(JSON.stringify({ get_round_entrants: { round_id: roundId } }));
  return `${LCD}/cosmwasm/wasm/v1/contract/${contractAddress}/smart/${query}`;
}

async function fetchBlockTimeIso(height: number): Promise<string> {
  const res = await fetch(`${RPC}/block?height=${height}`);
  if (!res.ok) throw new Error(`Block query failed (${res.status})`);
  const body = await res.json();
  const time = body?.result?.block?.header?.time;
  if (!time) throw new Error("Block response missing header.time");
  return time as string;
}

export async function verifyRound(
  roundId: number,
  contractAddress: string = WHEEL_MANAGER_ADDRESS
): Promise<VerifyRoundResult> {
  const [round, entrantsRes] = await Promise.all([
    getRoundHistory(roundId, contractAddress),
    getRoundEntrants(roundId, contractAddress),
  ]);
  if (round.status !== "drawn" || round.draw_height === null || !round.winner) {
    throw new Error("This round has not been drawn yet.");
  }
  const entrants = entrantsRes.entrants;
  if (entrants.length === 0) throw new Error("No entrants recorded for this round.");

  const blockTimeIso = await fetchBlockTimeIso(round.draw_height);
  const nanos = isoToNanos(blockTimeIso);

  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [
    u64BigEndian(BigInt(round.round_id)),
    u64BigEndian(BigInt(round.draw_height)),
    u64BigEndian(nanos),
  ];
  for (const addr of entrants) {
    chunks.push(encoder.encode(addr));
    chunks.push(new Uint8Array([0]));
  }
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const buffer = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.length;
  }

  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", buffer));
  const seed = new DataView(digest.buffer, 0, 8).getBigUint64(0, false);
  const winnerIndex = Number(seed % BigInt(entrants.length));
  const computedWinner = entrants[winnerIndex];

  return {
    roundId,
    drawHeight: round.draw_height,
    drawAfterHeight: round.draw_after_height!,
    drawGap: round.draw_height - round.draw_after_height!,
    blockTimeIso,
    entrants,
    digestHex: toHex(digest),
    winnerIndex,
    computedWinner,
    onChainWinner: round.winner,
    matches: computedWinner === round.winner,
    blockQueryUrl: `${RPC}/block?height=${round.draw_height}`,
    entrantsQueryUrl: entrantsQueryUrl(roundId, contractAddress),
  };
}

// Bundles every raw input and output into one plain-JSON blob - meant to be
// copy-pasted to anyone (or anything, including an AI asked to double-check)
// so the whole computation can be redone independently of this app, using
// only the two public data sources linked inside it.
export function buildVerificationPayload(result: VerifyRoundResult) {
  return {
    round_id: result.roundId,
    on_chain_winner: result.onChainWinner,
    draw_block_height: result.drawHeight,
    draw_eligible_at_height: result.drawAfterHeight,
    draw_gap_blocks: result.drawGap,
    draw_block_time_utc: result.blockTimeIso,
    entrants_in_order: result.entrants,
    formula:
      "winner = entrants[ SHA256(round_id as big-endian u64 || draw_block_height as big-endian u64 || draw_block_time in nanoseconds-since-epoch as big-endian u64 || for each entrant address: its UTF-8 bytes followed by one 0x00 byte)[first 8 bytes as big-endian u64] modulo entrants.length ]",
    sha256_digest_hex: result.digestHex,
    computed_winner_index: result.winnerIndex,
    computed_winner: result.computedWinner,
    matches_on_chain_winner: result.matches,
    sources: {
      block_data: result.blockQueryUrl,
      entrants_data: result.entrantsQueryUrl,
    },
  };
}
