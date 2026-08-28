use cosmwasm_std::Addr;
use sha2::{Digest, Sha256};

/// Deterministically picks a winner index into `entrants`, weighted by how many
/// times an address appears (one entry per ticket bought). `salt` lets Podium
/// draw several independent-looking picks (1st/2nd/3rd) from the same
/// `preimage` by hashing a different salt for each sequential draw.
///
/// Commit-reveal, not block data: the only unpredictable input is `preimage`,
/// a secret generated offline by the admin, committed (`sha256(preimage)`) to
/// `RaffleState::commit_used` when the fee/prize is funded (`ConsumeCommit`
/// against the factory), and revealed only when `RevealDraw` runs. `entrants`
/// is frozen the moment the raffle leaves `Open` (every entrants-mutating
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
/// same `preimage` across two different raffle instances by operational
/// mistake would make them pick the same relative winner index. **This does
/// NOT prevent a leak** (corrected 2026-08-28, Ronda 10 audit fix, Opus,
/// CYOL-3/medium) - see wheel-manager's matching `pick_winner_index` doc
/// comment for the full correction: the separator only stops the two picks
/// from coincidentally matching, it does nothing to keep a preimage revealed
/// in one raffle from letting anyone compute another raffle's winner too, if
/// the same commit was ever pushed to more than one of this project's
/// independent commit queues.
pub fn pick_winner_index(contract_addr: &Addr, preimage: &[u8], salt: u64, entrants: &[Addr]) -> usize {
    let mut hasher = Sha256::new();
    hasher.update(contract_addr.as_bytes());
    hasher.update([0u8]); // separator, avoids address-concatenation collisions
    hasher.update(preimage);
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
