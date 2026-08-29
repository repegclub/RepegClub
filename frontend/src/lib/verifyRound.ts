import { LCD } from "./chainConfig";
import { WHEEL_MANAGER_ADDRESS } from "./deployment";
import { getRoundEntrants, getRoundHistory } from "./queryWheelManager";

export type VerifyRoundResult = {
  roundId: number;
  contractAddress: string;
  commitUsedHex: string;
  preimageHex: string;
  entrants: string[];
  digestHex: string;
  winnerIndex: number;
  computedWinner: string;
  onChainWinner: string;
  matches: boolean;
  // Plain, independently-fetchable source for the one raw input not already
  // in the round response itself - a technical reader (or an AI asked to
  // double-check) can hit this directly and redo everything below without
  // trusting this app's own computation.
  entrantsQueryUrl: string;
};

// Mirrors contracts/wheel-manager/src/rand.rs::pick_winner_index exactly:
// SHA-256(contract_addr utf8 bytes | 0x00 separator | round_id BE u64 |
// preimage bytes | for each entrant: utf8 address bytes + 0x00), then the
// first 8 bytes of the digest (BE) modulo the entrant count picks the
// winning index. Commit-reveal, not block data - preimage/commit_used come
// straight from the round's own query response (GetRoundHistory), no RPC
// block lookup needed at all under v9.
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

function entrantsQueryUrl(roundId: number, contractAddress: string): string {
  const query = btoa(JSON.stringify({ get_round_entrants: { round_id: roundId } }));
  return `${LCD}/cosmwasm/wasm/v1/contract/${contractAddress}/smart/${query}`;
}

export async function verifyRound(
  roundId: number,
  contractAddress: string = WHEEL_MANAGER_ADDRESS
): Promise<VerifyRoundResult> {
  const [round, entrantsRes] = await Promise.all([
    getRoundHistory(roundId, contractAddress),
    getRoundEntrants(roundId, contractAddress),
  ]);
  if (round.status !== "drawn" || !round.revealed_preimage || !round.winner) {
    throw new Error("This round has not been drawn yet.");
  }
  const entrants = entrantsRes.entrants;
  if (entrants.length === 0) throw new Error("No entrants recorded for this round.");

  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [
    encoder.encode(contractAddress),
    new Uint8Array([0]),
    u64BigEndian(BigInt(round.round_id)),
    hexToBytes(round.revealed_preimage),
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
    contractAddress,
    commitUsedHex: round.commit_used ?? "",
    preimageHex: round.revealed_preimage,
    entrants,
    digestHex: toHex(digest),
    winnerIndex,
    computedWinner,
    onChainWinner: round.winner,
    matches: computedWinner === round.winner,
    entrantsQueryUrl: entrantsQueryUrl(roundId, contractAddress),
  };
}

// Bundles every raw input and output into one plain-JSON blob - meant to be
// copy-pasted to anyone (or anything, including an AI asked to double-check)
// so the whole computation can be redone independently of this app, using
// only the public data source linked inside it.
export function buildVerificationPayload(result: VerifyRoundResult) {
  return {
    round_id: result.roundId,
    contract_address: result.contractAddress,
    on_chain_winner: result.onChainWinner,
    commit_used_hex: result.commitUsedHex,
    revealed_preimage_hex: result.preimageHex,
    entrants_in_order: result.entrants,
    formula:
      "winner = entrants[ SHA256(contract_address as UTF-8 bytes || 0x00 || round_id as big-endian u64 || revealed_preimage bytes || for each entrant address: its UTF-8 bytes followed by one 0x00 byte)[first 8 bytes as big-endian u64] modulo entrants.length ]",
    sha256_digest_hex: result.digestHex,
    computed_winner_index: result.winnerIndex,
    computed_winner: result.computedWinner,
    matches_on_chain_winner: result.matches,
    sources: {
      entrants_data: result.entrantsQueryUrl,
    },
  };
}
