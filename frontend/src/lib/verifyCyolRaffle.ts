import { LCD, RPC } from "./chainConfig";
import { getEntrants, getRaffleStatus } from "./queryCyolRaffle";

export type VerifyCyolRaffleResult = {
  drawHeight: number;
  blockTimeIso: string;
  entrants: string[];
  digestHex: string;
  winnerIndex: number;
  computedWinner: string;
  onChainWinner: string;
  matches: boolean;
  blockQueryUrl: string;
  entrantsQueryUrl: string;
};

// Mirrors contracts/create-your-own-luck/src/rand.rs::pick_winner_index
// exactly (raffle_seed and salt are both always 0 for SingleWinner - only
// Podium, not exposed in this UI, uses a non-zero salt for its 2nd/3rd
// places): SHA-256(0 as BE u64 | draw block height BE u64 | draw block time
// in nanoseconds BE u64 | 0 as BE u64 | for each entrant: utf8 address bytes
// + 0x00), first 8 bytes (BE) modulo entrant count picks the winning index.
// Same pattern as lib/verifyRound.ts for Wheel of Repeg - draw_height/
// drawn_at alone aren't enough (the query only has whole-second precision,
// the hash needs nanoseconds), so this fetches the real historical block.
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

function entrantsQueryUrl(contractAddress: string): string {
  const query = btoa(JSON.stringify({ get_entrants: {} }));
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

export async function verifyCyolRaffle(contractAddress: string, onChainWinner: string): Promise<VerifyCyolRaffleResult> {
  const [status, entrantsRes] = await Promise.all([getRaffleStatus(contractAddress), getEntrants(contractAddress)]);
  if (status.status !== "drawn" || status.draw_height === null) {
    throw new Error("This raffle has not been drawn yet.");
  }
  const entrants = entrantsRes.entrants;
  if (entrants.length === 0) throw new Error("No entrants recorded for this raffle.");

  const blockTimeIso = await fetchBlockTimeIso(status.draw_height);
  const nanos = isoToNanos(blockTimeIso);

  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [
    u64BigEndian(0n), // raffle_seed - always 0
    u64BigEndian(BigInt(status.draw_height)),
    u64BigEndian(nanos),
    u64BigEndian(0n), // salt - always 0 for SingleWinner
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
    drawHeight: status.draw_height,
    blockTimeIso,
    entrants,
    digestHex: toHex(digest),
    winnerIndex,
    computedWinner,
    onChainWinner,
    matches: computedWinner === onChainWinner,
    blockQueryUrl: `${RPC}/block?height=${status.draw_height}`,
    entrantsQueryUrl: entrantsQueryUrl(contractAddress),
  };
}

// Same "copy this to anyone, including an AI, to redo it independently"
// bundle as buildVerificationPayload in verifyRound.ts.
export function buildCyolVerificationPayload(contractAddress: string, result: VerifyCyolRaffleResult) {
  return {
    raffle_contract_address: contractAddress,
    on_chain_winner: result.onChainWinner,
    draw_block_height: result.drawHeight,
    draw_block_time_utc: result.blockTimeIso,
    entrants_in_order: result.entrants,
    formula:
      "winner = entrants[ SHA256(0u64 as big-endian || draw_block_height as big-endian u64 || draw_block_time in nanoseconds-since-epoch as big-endian u64 || 0u64 as big-endian || for each entrant address: its UTF-8 bytes followed by one 0x00 byte)[first 8 bytes as big-endian u64] modulo entrants.length ]",
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
