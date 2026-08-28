use cosmwasm_std::Addr;
use sha2::{Digest, Sha256};

/// Deterministically picks a winner index into `entrants`, weighted by how many
/// times an address appears (one entry per ticket bought).
///
/// Commit-reveal, not block data: the only unpredictable input is `preimage`,
/// a secret generated offline by the admin, committed (`sha256(preimage)`) to
/// `Round::commit_used` when the round opens (`execute::open_new_round`) or
/// via the permissionless backfill (`AssignCommit`), and revealed only when
/// `RevealDraw` runs. `entrants` is frozen the moment the round leaves `Open`
/// (see `execute_close_round`'s doc comment on why every entrants-mutating
/// function requires `status == Open`), so by the time this function runs,
/// every input is fixed and known to nobody who wasn't already trusted with
/// the preimage. This replaces the block-height/block-time hash this project
/// used before v9 (see the project's Obsidian notes, "Grinding vía
/// SubMsg+reply" - a contract-as-caller could observe the outcome via
/// `SubMsg`+`reply` and revert on a loss, cheaply and repeatedly, because
/// that older scheme let the same transaction that ran the draw also supply
/// its own randomness input).
///
/// `contract_addr` is included as a domain separator: without it, reusing the
/// same `preimage` across two different contract instances by operational
/// mistake would make them pick the same relative winner index, and revealing
/// one would leak the other's secret early. Nothing else here depends on
/// `info.sender`, `env.block.*`, or any other value a caller controls or can
/// observe before committing to a transaction.
pub fn pick_winner_index(
    contract_addr: &Addr,
    round_id: u64,
    preimage: &[u8],
    entrants: &[Addr],
) -> usize {
    let mut hasher = Sha256::new();
    hasher.update(contract_addr.as_bytes());
    hasher.update([0u8]); // separator, avoids address/id-concatenation collisions
    hasher.update(round_id.to_be_bytes());
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
