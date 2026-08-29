import { LCD } from "./chainConfig";
import { getEntrants, getRaffleStatus } from "./queryCyolRaffle";

export type VerifyCyolRaffleResult = {
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

// Mirrors contracts/create-your-own-luck/src/rand.rs::pick_winner_index
// exactly (salt is always 0 for SingleWinner - only Podium, not exposed in
// this UI, uses a non-zero salt for its 2nd/3rd places): SHA-256(contract_addr
// utf8 bytes | 0x00 separator | preimage bytes | salt(0) BE u64 | for each
// entrant: utf8 address bytes + 0x00), first 8 bytes (BE) modulo entrant
// count picks the winning index. Commit-reveal, not block data -
// preimage/commit_used come straight from GetRaffleStatus, no RPC block
// lookup needed at all under v9 (unlike the pre-v9 formula this replaces).
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

function entrantsQueryUrl(contractAddress: string): string {
  const query = btoa(JSON.stringify({ get_entrants: {} }));
  return `${LCD}/cosmwasm/wasm/v1/contract/${contractAddress}/smart/${query}`;
}

export async function verifyCyolRaffle(contractAddress: string, onChainWinner: string): Promise<VerifyCyolRaffleResult> {
  const [status, entrantsRes] = await Promise.all([getRaffleStatus(contractAddress), getEntrants(contractAddress)]);
  if (status.status !== "drawn" || !status.revealed_preimage) {
    throw new Error("This raffle has not been drawn yet.");
  }
  const entrants = entrantsRes.entrants;
  if (entrants.length === 0) throw new Error("No entrants recorded for this raffle.");

  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [
    encoder.encode(contractAddress),
    new Uint8Array([0]),
    hexToBytes(status.revealed_preimage),
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
    contractAddress,
    commitUsedHex: status.commit_used ?? "",
    preimageHex: status.revealed_preimage,
    entrants,
    digestHex: toHex(digest),
    winnerIndex,
    computedWinner,
    onChainWinner,
    matches: computedWinner === onChainWinner,
    entrantsQueryUrl: entrantsQueryUrl(contractAddress),
  };
}

// Same "copy this to anyone, including an AI, to redo it independently"
// bundle as buildVerificationPayload in verifyRound.ts.
export function buildCyolVerificationPayload(contractAddress: string, result: VerifyCyolRaffleResult) {
  return {
    raffle_contract_address: contractAddress,
    on_chain_winner: result.onChainWinner,
    commit_used_hex: result.commitUsedHex,
    revealed_preimage_hex: result.preimageHex,
    entrants_in_order: result.entrants,
    formula:
      "winner = entrants[ SHA256(contract_address as UTF-8 bytes || 0x00 || revealed_preimage bytes || 0u64 as big-endian (salt) || for each entrant address: its UTF-8 bytes followed by one 0x00 byte)[first 8 bytes as big-endian u64] modulo entrants.length ]",
    sha256_digest_hex: result.digestHex,
    computed_winner_index: result.winnerIndex,
    computed_winner: result.computedWinner,
    matches_on_chain_winner: result.matches,
    sources: {
      entrants_data: result.entrantsQueryUrl,
    },
  };
}
