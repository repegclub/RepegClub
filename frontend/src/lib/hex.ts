// Shared by the 3 verify*.ts modules - decodes a HexBinary string (as
// returned by the contracts' commit_used/revealed_preimage query fields)
// into raw bytes for hashing.
export function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  if (hex.length % 2 !== 0) throw new Error(`Odd-length hex string: ${hex}`);
  // parseInt would turn a non-hex pair into NaN -> 0 silently (audit 2026-11-18, R23)
  if (!/^[0-9a-fA-F]*$/.test(hex)) throw new Error(`Not a hex string: ${hex}`);
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
