use cosmwasm_std::Addr;
use sha2::{Digest, Sha256};

/// See wheel-manager's matching `pick_winner_index` for the full rationale -
/// same commit-reveal mechanism, replacing the block-height/block-time hash
/// this contract used before v9.
pub fn pick_winner_index(
    contract_addr: &Addr,
    week_id: u64,
    preimage: &[u8],
    entrants: &[Addr],
) -> usize {
    let mut hasher = Sha256::new();
    hasher.update(contract_addr.as_bytes());
    hasher.update([0u8]);
    hasher.update(week_id.to_be_bytes());
    hasher.update(preimage);
    for entrant in entrants {
        hasher.update(entrant.as_bytes());
        hasher.update([0u8]);
    }
    let digest = hasher.finalize();
    let mut seed_bytes = [0u8; 8];
    seed_bytes.copy_from_slice(&digest[0..8]);
    let seed = u64::from_be_bytes(seed_bytes);
    (seed % entrants.len() as u64) as usize
}
