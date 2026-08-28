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
/// mistake would make them pick the same relative winner index. **This does
/// NOT prevent a leak** (corrected 2026-08-28, Ronda 10 audit fix, Opus,
/// CYOL-3/medium - a prior version of this comment claimed it did): if
/// `preimage` becomes public from instance A (e.g. a legitimate `RevealDraw`
/// tx), anyone can compute instance B's winner too, using B's own public
/// `contract_addr` - the separator only stops the two picks from coincidentally
/// matching, it does nothing to keep the preimage itself confined to A. The
/// only real protection is procedural: **never push the same commit
/// (`sha256(preimage)`) to more than one of this project's independent commit
/// queues** (this contract's own `COMMIT_QUEUE`, weekly-round's, and
/// create-your-own-luck-factory's - each with its own separate `USED_COMMITS`,
/// so nothing on-chain stops a duplicate across them). Nothing else in this
/// function depends on `info.sender`, `env.block.*`, or any other value a
/// caller controls or can observe before committing to a transaction.
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
