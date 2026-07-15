use cosmwasm_std::Addr;
use sha2::{Digest, Sha256};

/// Deterministically picks a winner index into `entrants`, weighted by how many
/// times an address appears (one entry per ticket bought). `salt` lets Podium
/// draw three independent-looking picks (1st/2nd/3rd) from the same block
/// height/time by hashing a different salt for each sequential draw.
///
/// KNOWN LIMITATION: same block-based-randomness caveat as wheel-manager's
/// `rand.rs` - see that file for the full writeup (residual validator-grinding
/// risk within `draw_window_blocks`, and why commit-reveal / Nois were
/// evaluated and deferred rather than built now).
pub fn pick_winner_index(
    raffle_seed: u64,
    block_height: u64,
    block_time_nanos: u64,
    salt: u64,
    entrants: &[Addr],
) -> usize {
    let mut hasher = Sha256::new();
    hasher.update(raffle_seed.to_be_bytes());
    hasher.update(block_height.to_be_bytes());
    hasher.update(block_time_nanos.to_be_bytes());
    hasher.update(salt.to_be_bytes());
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
