use cosmwasm_std::Addr;
use sha2::{Digest, Sha256};

/// Deterministically picks a winner index into `entrants`, weighted by how many
/// times an address appears (one entry per ticket bought). The source of
/// randomness is the block height + time at the moment `DrawWinner` executes
/// (checked by the caller to be `draw_delay_blocks` after the round closed),
/// hashed together with the ordered list of entrants for that round.
///
/// KNOWN LIMITATION (security review, 2026-07-14): this is block-based
/// randomness, which a block proposer can influence (they choose their own
/// block's timestamp and whether to include the draw tx) - the classic
/// "block.timestamp as randomness" class of issue. `Config::draw_window_blocks`
/// bounds how many blocks a caller can wait through for a favorable one, which
/// closes off grinding by casual (non-validator) callers, but a colluding
/// validator retains some residual influence within that window. The
/// stronger, self-contained fix (no external chain dependency) is
/// commit-reveal: each entrant submits `sha256(secret)` at ticket-purchase
/// time and reveals it before the draw, so the seed depends on entropy no
/// single party - proposer included - controls or can predict. Not built yet
/// because it requires an extra transaction per player (reveal step) - real
/// UX cost, likely worth it once the pool size justifies it. The
/// externally-hosted alternative (Nois Network, drand-over-IBC) was also
/// evaluated and set aside: Terra Classic has no IBC channel to Nois today,
/// and integrating one means new relayer infrastructure plus turning the draw
/// into an async two-step (request/callback) flow.
pub fn pick_winner_index(
    round_id: u64,
    block_height: u64,
    block_time_nanos: u64,
    entrants: &[Addr],
) -> usize {
    let mut hasher = Sha256::new();
    hasher.update(round_id.to_be_bytes());
    hasher.update(block_height.to_be_bytes());
    hasher.update(block_time_nanos.to_be_bytes());
    for entrant in entrants {
        hasher.update(entrant.as_bytes());
        hasher.update([0u8]); // separator, avoids address-concatenation collisions
    }
    let digest = hasher.finalize();
    let mut seed_bytes = [0u8; 8];
    seed_bytes.copy_from_slice(&digest[0..8]);
    let seed = u64::from_be_bytes(seed_bytes);
    (seed % entrants.len() as u64) as usize
}
