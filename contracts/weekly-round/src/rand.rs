use cosmwasm_std::Addr;
use sha2::{Digest, Sha256};

/// Deterministically picks a winner index into `entrants`, weighted by how many
/// times an address appears (one entry per ticket bought). The source of
/// randomness is the block height + time at the moment `DrawWeeklyWinner`
/// executes (checked by the caller to be `draw_delay_blocks` after the week
/// closed), hashed together with the ordered list of entrants for that week.
pub fn pick_winner_index(
    week_id: u64,
    block_height: u64,
    block_time_nanos: u64,
    entrants: &[Addr],
) -> usize {
    let mut hasher = Sha256::new();
    hasher.update(week_id.to_be_bytes());
    hasher.update(block_height.to_be_bytes());
    hasher.update(block_time_nanos.to_be_bytes());
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
