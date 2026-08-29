import { LCD } from "./chainConfig";
import { WEEKLY_ROUND_ADDRESS } from "./deployment";
import { getWeekEntrants, getWeekHistory } from "./queryWeeklyRound";

export type VerifyWeeklyRoundResult = {
  weekId: number;
  contractAddress: string;
  commitUsedHex: string;
  preimageHex: string;
  entrants: string[];
  digestHex: string;
  winnerIndex: number;
  computedWinner: string;
  onChainWinner: string;
  matches: boolean;
  entrantsQueryUrl: string;
};

// Mirrors contracts/weekly-round/src/rand.rs::pick_winner_index exactly - same
// formula as Wheel Manager's (see lib/verifyRound.ts for the full writeup),
// just week_id in place of round_id.
function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error(`Odd-length hex string: ${hex}`);
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function u64BigEndian(n: bigint): Uint8Array {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setBigUint64(0, n, false);
  return new Uint8Array(buf);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function entrantsQueryUrl(weekId: number, contractAddress: string): string {
  const query = btoa(JSON.stringify({ get_week_entrants: { week_id: weekId } }));
  return `${LCD}/cosmwasm/wasm/v1/contract/${contractAddress}/smart/${query}`;
}

export async function verifyWeeklyRound(
  weekId: number,
  contractAddress: string = WEEKLY_ROUND_ADDRESS
): Promise<VerifyWeeklyRoundResult> {
  const [week, entrantsRes] = await Promise.all([
    getWeekHistory(weekId, contractAddress),
    getWeekEntrants(weekId, contractAddress),
  ]);
  if (week.status !== "drawn" || !week.revealed_preimage || !week.winner) {
    throw new Error("This week has not been drawn yet.");
  }
  const entrants = entrantsRes.entrants;
  if (entrants.length === 0) throw new Error("No entrants recorded for this week.");

  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [
    encoder.encode(contractAddress),
    new Uint8Array([0]),
    u64BigEndian(BigInt(week.week_id)),
    hexToBytes(week.revealed_preimage),
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
    weekId,
    contractAddress,
    commitUsedHex: week.commit_used ?? "",
    preimageHex: week.revealed_preimage,
    entrants,
    digestHex: toHex(digest),
    winnerIndex,
    computedWinner,
    onChainWinner: week.winner,
    matches: computedWinner === week.winner,
    entrantsQueryUrl: entrantsQueryUrl(weekId, contractAddress),
  };
}

export function buildWeeklyVerificationPayload(result: VerifyWeeklyRoundResult) {
  return {
    week_id: result.weekId,
    contract_address: result.contractAddress,
    on_chain_winner: result.onChainWinner,
    commit_used_hex: result.commitUsedHex,
    revealed_preimage_hex: result.preimageHex,
    entrants_in_order: result.entrants,
    formula:
      "winner = entrants[ SHA256(contract_address as UTF-8 bytes || 0x00 || week_id as big-endian u64 || revealed_preimage bytes || for each entrant address: its UTF-8 bytes followed by one 0x00 byte)[first 8 bytes as big-endian u64] modulo entrants.length ]",
    sha256_digest_hex: result.digestHex,
    computed_winner_index: result.winnerIndex,
    computed_winner: result.computedWinner,
    matches_on_chain_winner: result.matches,
    sources: {
      entrants_data: result.entrantsQueryUrl,
    },
  };
}
