use cosmwasm_std::{
    entry_point, Binary, Deps, DepsMut, Env, MessageInfo, Reply, Response, StdError, StdResult, Uint128,
};

use crate::error::ContractError;
use crate::execute::{
    claim_expired_raffle, execute_buy_ticket, execute_cancel_raffle, execute_claim_airdrop_share,
    execute_close_round, execute_deposit_prize, execute_expire_raffle,
    execute_finalize_expire_closed_raffle, execute_pay_service_fee, execute_reclaim_unclaimed,
    execute_receive, execute_request_expire_closed_raffle, execute_retry_prize_payout,
    execute_reveal_draw, execute_withdraw_ticket, max_tickets_per_wallet, reply as reply_impl,
};
use crate::factory_msgs::{CancellationPenaltyResponse, FactoryQueryMsg};
use crate::msg::{ExecuteMsg, InstantiateMsg, QueryMsg};
use crate::query::query as query_impl;
use crate::state::{Config, PrizeAsset, RaffleState, RaffleStatus, RaffleType, CONFIG, RAFFLE};

/// Hard ceiling on `podium_shares_bps.len()`. Two reasons: (1) gas safety -
/// without this, a raffle with an unbounded number of places would do
/// O(places x entrants) hashing and emit one BankMsg::Send per place inside a
/// single `DrawWinner` call, and if that ever exceeded the block gas limit
/// the raffle would be stuck `Closed` forever (undrawable, and
/// `CancelRaffle` is blocked once `Closed`); (2) product clarity - "Podium"
/// is meant to be a handful of ranked prize tiers, distinct from `Airdrop`
/// (equal split across every player). A high place count would blur that
/// line into a disguised, cheaper Airdrop.
const MAX_PODIUM_PLACES: u32 = 10;

/// Hard ceiling on `max_players` for SingleWinner/Podium raffles. CodeRabbit
/// review (2026-07-15) found that, unlike Airdrop (naturally capped at 1000
/// by the fee tiers, and capped at 1 ticket/wallet), SingleWinner/Podium had
/// no ceiling at all: with the max_tickets_per_wallet formula (max_players/2),
/// entrants can reach max_players^2/2, and CancelRaffle's
/// unique_players x entrants scan can reach roughly max_players^3/2 - at
/// max_players=1000 that's ~500 million comparisons in one transaction.
/// Capped at 100 (worst case ~500k, comfortably safe) - confirmed with the
/// user 2026-07-15.
const MAX_PLAYERS_SINGLE_WINNER_PODIUM: u32 = 100;

/// Hard ceiling on `max_players` for Airdrop, enforced unconditionally - not
/// just for free raffles. Until the 2026-07-21 fee overhaul below, this was
/// an implicit side effect of the fee-tier lookup (`FREE_RAFFLE_FEE_TIERS_USDC`/
/// its Airdrop-only predecessor) running for every Airdrop and rejecting
/// anything past its last tier's 1000 cap - true regardless of `ticket_price`
/// at the time. Splitting the fee formula by free-vs-paid silently dropped
/// that ceiling for paid Airdrops (the % formula has no upper bound of its
/// own), reopening exactly the gas blowup class `MAX_PLAYERS_SINGLE_WINNER_PODIUM`
/// above was created to prevent: `cancel_refund_messages`
/// (Cancel/ExpireRaffle) emits one message per unique player, and
/// `ReclaimUnclaimed` loops every unique player too - both O(max_players) in
/// a single transaction, which a large-enough paid Airdrop could push past
/// the block gas limit and strand permanently (defeating `ExpireRaffle`'s
/// own safety-net purpose in the process). Found by an Opus+Fable review
/// (2026-07-21) of that same fee overhaul - re-added as its own explicit,
/// price-independent check instead of leaning on the fee lookup again.
const MAX_PLAYERS_AIRDROP: u32 = 1000;

/// Bounds on `unclaimed_deadline_days`, a creator-chosen field controlling
/// how long before an Airdrop's unclaimed shares can be swept back to the
/// creator (`execute_reclaim_unclaimed`). (Corrected 2026-08-28, Ronda 10
/// audit fix, Opus/Q2: a prior version of this comment described a second
/// reuse of this same field - gating how long a `Closed` raffle stayed
/// creator-only before `DrawWinner` fell back to permissionless - that
/// mechanism was removed entirely in v9's commit-reveal redesign, where
/// `RevealDraw` is permissionless from the start with no creator-exclusive
/// period at all; the field has had only its one Airdrop-sweep purpose since
/// then, and nothing in the current code reads it for anything else.)
/// Unvalidated, an astronomically large value (with `overflow-checks = true`)
/// would panic the sweep-deadline math. Found by an Opus+Fable review
/// (2026-07-21). 365 as an upper bound keeps the worst case to at most a
/// year, not decades - a real, human-scale ceiling, not just avoiding a panic.
const MIN_UNCLAIMED_DEADLINE_DAYS: u64 = 1;
const MAX_UNCLAIMED_DEADLINE_DAYS: u64 = 365;

/// Bounds on `round_timeout_seconds`, a creator-chosen field (like
/// `unclaimed_deadline_days` above) that was left unvalidated at instantiate
/// until an Opus+Fable review (2026-07-21) pointed out the same bug class was
/// still open here. Feeds `execute_buy_ticket`'s soft-close deadline
/// (`env.block.time.plus_seconds(round_timeout_seconds)`, moved here from
/// `execute_close_round` by the 2026-08-20 soft-close redesign); with
/// `overflow-checks = true` an astronomical value panics that addition, and
/// unlike the old DrawWinner creator-exclusivity fallback (removed in v9's
/// commit-reveal redesign - see the project's Obsidian notes), `CloseRound`
/// has no permissionless/deadline rescue if it can never be evaluated - a
/// raffle that can never close can never reach `CancelRaffle`'s only escape
/// either (blocked once `Closed`, and only reachable from `Open`/`Funding`
/// while the creator is willing to call it), stranding every ticket buyer's
/// money, not just the creator's own. The upper bound keeps the worst case (a
/// picked-but-not-overflowing absurd value) to low-single-digit years, not
/// decades - same "human-scale ceiling" reasoning as `MAX_UNCLAIMED_DEADLINE_DAYS`.
/// (`draw_delay_blocks`/`draw_window_blocks` used to be bounded here too, for
/// the old block-hash draw mechanism's own rearm window - removed along with
/// that mechanism in v9, replaced by `MAX_REVEAL_AGE_SECONDS`/`execute::
/// EXPIRE_*` instead.)
/// 24h-31 days (2026-08-22 audit round 10 fix, raised from the original
/// 1h-31 day range of the 2026-08-20 soft-close redesign) - narrower than
/// the old 60s-365day range because this is now the creator's real,
/// meaningful "how long am I planning my marketing window for" choice (see
/// `Config::round_timeout_seconds`'s doc comment), not just an overflow-
/// safety bound; over 31 days stops being a "round" and starts overlapping
/// with `MAX_RAFFLE_AGE_SECONDS`'s own 60-day hard cap.
///
/// The floor was originally 1 hour - exactly `ANTI_SNIPE_EXTENSION_SECONDS`.
/// Proven degenerate (round 10 audit, live test): the anti-snipe extension
/// fires whenever `seconds_remaining <= ANTI_SNIPE_EXTENSION_SECONDS`, so a
/// raffle instantiated at the old floor starts its life already inside that
/// window - literally every purchase at any point extends the deadline by
/// another hour, turning the "final hour" into the raffle's entire
/// lifetime. This is exactly the rolling-deadline behavior
/// `Config::round_timeout_seconds`'s own doc comment says soft-close was
/// designed to avoid, and it's what the real frontend always instantiates
/// with (`createRaffle.ts`'s `ROUND_TIMEOUT_SECONDS`, not creator-
/// configurable yet) - so every app-created raffle hit it. Raising the
/// floor to 24h (24x `ANTI_SNIPE_EXTENSION_SECONDS`) guarantees a real,
/// stable period outside the anti-snipe zone for every value in range,
/// without needing to touch the extension math itself.
const MIN_ROUND_TIMEOUT_SECONDS: u64 = 86_400;
const MAX_ROUND_TIMEOUT_SECONDS: u64 = 2_678_400; // 31 days
/// Fixed anti-snipe extension (2026-08-20 design) - a ticket purchase
/// landing in the final hour before `RaffleState::deadline` pushes it out
/// by exactly this much, capped at `MAX_RAFFLE_AGE_SECONDS` from
/// `opened_at`. Deliberately NOT creator-configurable (unlike
/// `round_timeout_seconds`) - the whole point is a small, fixed, well-
/// understood grace window, not another dial a creator has to reason about.
pub(crate) const ANTI_SNIPE_EXTENSION_SECONDS: u64 = 3_600;
/// Absolute hard cap on a raffle's total lifetime from `opened_at`, fixed
/// platform-wide (2026-08-20) - replaces the old creator-chosen
/// `max_raffle_age_seconds` field entirely. Serves 2 purposes: (1) if
/// `min_players` is never reached, `ExpireRaffle` can force a refund after
/// this long; (2) if `min_players` WAS reached but anti-snipe extensions
/// keep pushing `deadline` out, this still forces a close eventually. A
/// FIXED 60 days (not a multiplier of the creator's chosen window - both a
/// flat 4x and Wheel Manager's real ~48x ratio were considered and rejected
/// during design, since neither is principled for CYOL's week/month-scale
/// windows) gives every raffle the same real ceiling regardless of how
/// aggressive its anti-snipe extensions get.
pub(crate) const MAX_RAFFLE_AGE_SECONDS: u64 = 5_184_000; // 60 days
/// How long, in seconds since `closed_at`, a `Closed` raffle can wait for a
/// legitimate `RevealDraw` before `RequestExpireClosedRaffle` becomes
/// callable - the outage safety net (see `execute::EXPIRE_*` docs). Fixed
/// platform-wide, deliberately NOT creator-configurable - same reasoning as
/// `ANTI_SNIPE_EXTENSION_SECONDS`: a small, fixed, well-understood grace
/// window. Ronda 9 audit finding (Opus, bloqueante 8): if this followed the
/// pattern of every other creator-chosen timing field in this contract, the
/// front-run-the-reveal risk (see the project's Obsidian notes, "Grinding
/// vía SubMsg+reply") would become available in NORMAL operation instead of
/// only after a real operator outage, with the creator incentivized to set
/// it low specifically to recover their own prize.
pub(crate) const MAX_REVEAL_AGE_SECONDS: u64 = 3_600; // 1 hour

/// Free-raffle (`ticket_price` zero) fee schedule, keyed by `max_players`
/// ceiling (ascending, USDC micros) - judged by community size, since
/// there's no ticket revenue to judge by. Originally Airdrop-only; unified
/// across all 3 raffle types (2026-07-21) once paid raffles got their own,
/// revenue-based formula below - SingleWinner/Podium's 100-player ceiling
/// always lands in the first tier, so this is a no-op change for them, but
/// keeps one schedule instead of a redundant second one. Discount is a
/// growth incentive, not cost-recovery - each participant pays their own
/// claim gas, so the platform's per-participant cost doesn't scale linearly.
/// Confirmed with the user 2026-07-15 (see docs/rueda-del-repeg-diseno.html
/// §09, which had these as examples pending confirmation).
const FREE_RAFFLE_FEE_TIERS_USDC: [(u32, u128); 4] = [
    (100, 3_000_000),   // "$3"
    (300, 7_000_000),   // "$7"
    (600, 12_000_000),  // "$12"
    (1000, 18_000_000), // "$18"
];

/// Paid-raffle fee: 1% of the raffle's theoretical maximum ticket revenue,
/// floored at $1 (2026-07-21, replacing a flat $3 for SingleWinner/Podium
/// regardless of scale - a creator could under-report `max_players` while
/// setting an arbitrarily high `ticket_price` and pay the same $3 as a
/// two-player raffle, even though the theoretical revenue ceiling scales
/// with both fields together, not `max_players` alone). Comparable to
/// crowdfunding platforms (Kickstarter ~5%, GoFundMe ~2.9%+fee) while staying
/// cheap enough to be attractive at any scale - a $46-potential raffle pays
/// the $1 floor, a $49,510-potential one pays ~$495, both proportional.
/// "Maximum" here is the same worst-case `max_entrants` ceiling used
/// platform-wide (every wallet maxing out its per-wallet ticket cap, plus
/// the last wallet needed to trigger auto-close buying exactly 1) - it's the
/// only value known at instantiate time, before any real tickets are sold.
const PAID_RAFFLE_FEE_BPS: u128 = 100; // 1%
const FEE_BPS_DENOM: u128 = 10_000;
const MIN_PAID_RAFFLE_FEE_USDC: u128 = 1_000_000; // "$1"

/// `ticket_price` is binary, not a spectrum: either exactly 0 (free) or at
/// least $1, in whole-cent increments from there (2026-07-21, Opus+Fable
/// review of the free-raffle anti-whale cap). Without a floor, a "paid"
/// raffle priced at 1 micro-USDC still satisfies `!ticket_price.is_zero()`
/// and gets the paid-raffle per-wallet cap (`max_players / 2`) instead of the
/// free-raffle cap of 1 - for a fraction of a cent, a single wallet could
/// grab up to half of `max_players`' worth of entries, exactly the
/// domination the free-raffle cap exists to prevent. The whole-cent
/// requirement closes the same gap at every step above the floor (e.g.
/// $1.0001 would otherwise still be a legal, real-money-indistinguishable
/// dust increment) and keeps prices in real-economy terms (`$1.01`, not
/// `$1.000001`).
const MIN_PAID_TICKET_PRICE_USDC: u128 = 1_000_000; // "$1"
const USDC_CENT_MICROS: u128 = 10_000; // "$0.01"

/// Platform fee-recipient addresses, hardcoded (not creator-supplied) so a
/// raffle creator can never redirect the service fee to their own wallet.
/// Same addresses used platform-wide for Wheel Manager/Weekly Round's
/// admin_fee_address/treasury_address (see scripts/testnet/src/config.ts) -
/// one founder-fee wallet for the whole platform, not one per product.
/// Testnet values today; swap for the real mainnet addresses (and
/// USDC_DENOM below) in the final production redeploy, same as every other
/// contract in this project.
const FOUNDER_FEE_ADDRESS: &str = "terra15dv0f2rykyp6gyvuhawk8qgfd7ypm4lgkm4z39";
const TREASURY_ADDRESS: &str = "terra1juzyema7r4gvrrvrkkznceyeyhfkdj6zvz20fd";
/// Hardcoded for the same reason - a creator-chosen denom could be a
/// worthless token dressed up as "USDC", satisfying the fee amount check
/// without paying anything of real value.
///
/// Set to LUNC's own denom for now (2026-07-23), same testnet stand-in
/// convention Wheel Manager/Weekly Round already use for "USDC" (real USDC
/// has no liquidity on rebel-2) - found live: the originally chosen
/// "utestusdc" placeholder had zero total supply anywhere on this chain,
/// so no wallet, including test scripts, could ever actually pay the
/// service fee or buy a paid ticket. Swap for the real USDC IBC denom
/// before mainnet, same as every other testnet placeholder in this file.
const USDC_DENOM: &str = "uluna";
/// LUNC's denom is the same on every network - it's the chain's own
/// staking/gas token, not an IBC asset with a network-specific hash.
const LUNC_DENOM: &str = "uluna";
/// Real, governance-approved denom (see
/// scripts/testnet/src/configMainnetTest.ts, sourced from
/// docs/terra-classic-chain-notes.md) - same value on testnet and mainnet,
/// unlike `USDC_DENOM` above.
const USTC_DENOM: &str = "uusd";

/// Native prize whitelist for paid raffles (2026-07-21): a raffle where
/// players pay a real ticket price can only offer LUNC/USDC/USTC as a
/// native prize (a separately factory-whitelisted CW20 is also allowed as
/// of the 2026-08-20 redesign - see the CW20 branch below). Native denom
/// identity can't be spoofed (it's the exact chain/channel hash, not
/// creator-controlled metadata), but CW20
/// `name`/`symbol` fields are pure creator-chosen strings disconnected from
/// the contract's real identity - anyone can deploy their own CW20, call it
/// "USDC", and use it as the prize, collecting real ticket revenue while
/// handing out a worthless clone to the winner. This chain's own history
/// (a dozen+ real, unforged native "stablecoins" - KRT, EUT, etc. - that
/// depegged alongside USTC) means even an unrestricted *native* choice
/// isn't automatically safe without a token-identity display the frontend
/// doesn't build yet, so the same 3-asset list applies to natives too for
/// now. New assets (native or CW20) get added here only after manual
/// review (liquidity, volume, community standing, and for CW20 specifically
/// confirming standard, non-malicious transfer behavior) - not exposed as
/// a creator-facing form field yet.
///
/// Deliberately NOT applied when `ticket_price` is zero: with no one paying
/// to enter, the raffle is functionally a podium/single-winner-shaped
/// airdrop - a bad prize can only shortchange participants relative to
/// their expectations, never extract real money from them, since nobody
/// put any in.
const ALLOWED_PAID_NATIVE_PRIZE_DENOMS: [&str; 3] = [LUNC_DENOM, USDC_DENOM, USTC_DENOM];

/// The theoretical maximum number of tickets a raffle could ever sell: every
/// wallet but the last maxes out `max_tickets_per_wallet`, and the last
/// wallet needed to reach `max_players` (which auto-closes the raffle the
/// instant it buys its first ticket) only ever manages exactly 1. Not
/// `max_players * cap` - that overcounts, since the closing wallet can't buy
/// a second ticket in the same transaction that just closed the raffle. Used
/// both here (fee calculation) and conceptually matches what the frontend
/// should show creators as "tickets you could sell" (mirrors the same
/// worst-case reasoning already used for Wheel of Repeg's "available
/// tickets" display).
fn max_entrants(raffle_type: RaffleType, max_players: u32, ticket_price: Uint128) -> u128 {
    let cap = max_tickets_per_wallet(raffle_type, max_players, ticket_price) as u128;
    (max_players as u128 - 1) * cap + 1
}

/// Computes the required service fee on-chain instead of trusting a
/// creator-supplied amount - closes off a creator quietly setting their own
/// fee to near-zero. Free raffles (no ticket revenue to judge by) use the
/// community-size tier schedule; paid SingleWinner/Podium use 1% of
/// theoretical maximum revenue, floored at $1 (see `PAID_RAFFLE_FEE_BPS`
/// doc comment for why).
///
/// Paid Airdrop is the one exception, fixed 2026-08-23 after the user
/// noticed live that a large paid Airdrop had become dramatically cheaper
/// than an equivalently-sized free one (a $1-ticket, 1000-player Airdrop
/// paid ~$10 vs a free one's $18 tier fee - about 44% cheaper for taking
/// real money instead of none). The tier schedule above was originally
/// Airdrop-only and applied regardless of price - it only got displaced for
/// paid Airdrop when the 2026-07-21 revenue-based formula was introduced
/// generically for "paid raffles" without carrying the tier floor forward.
/// Paid Airdrop's fee is now `max(tier schedule, 1% of theoretical
/// revenue)`: never cheaper than a free Airdrop of the same `max_players`
/// (the tier schedule's own community-size reasoning doesn't stop applying
/// just because tickets are priced), but still scales up past the tier cap
/// for a high enough ticket price, where real revenue justifies a bigger
/// fee than the flat schedule alone would charge.
fn required_fee_usdc(raffle_type: RaffleType, max_players: u32, ticket_price: Uint128) -> Result<Uint128, ContractError> {
    let tier_fee = || -> Result<Uint128, ContractError> {
        FREE_RAFFLE_FEE_TIERS_USDC
            .iter()
            .find(|(cap, _)| max_players <= *cap)
            .map(|(_, fee)| Uint128::new(*fee))
            .ok_or(ContractError::MaxPlayersExceedsFreeRaffleFeeTiers {})
    };

    if ticket_price.is_zero() {
        return tier_fee();
    }

    let entrants = max_entrants(raffle_type, max_players, ticket_price);
    let max_potential_revenue = ticket_price
        .checked_mul(Uint128::from(entrants))
        .map_err(|_| ContractError::FeeCalculationOverflow {})?;
    let percent_fee = max_potential_revenue.multiply_ratio(PAID_RAFFLE_FEE_BPS, FEE_BPS_DENOM);
    let revenue_fee = std::cmp::max(percent_fee, Uint128::new(MIN_PAID_RAFFLE_FEE_USDC));

    if raffle_type == RaffleType::Airdrop {
        return Ok(std::cmp::max(revenue_fee, tier_fee()?));
    }
    Ok(revenue_fee)
}

#[entry_point]
pub fn instantiate(
    deps: DepsMut,
    _env: Env,
    info: MessageInfo,
    msg: InstantiateMsg,
) -> Result<Response, ContractError> {
    if msg.min_players < 2 || msg.max_players < msg.min_players {
        return Err(ContractError::InvalidPlayerBounds {});
    }
    if msg.unclaimed_deadline_days < MIN_UNCLAIMED_DEADLINE_DAYS
        || msg.unclaimed_deadline_days > MAX_UNCLAIMED_DEADLINE_DAYS
    {
        return Err(ContractError::InvalidUnclaimedDeadlineDays {
            min: MIN_UNCLAIMED_DEADLINE_DAYS,
            max: MAX_UNCLAIMED_DEADLINE_DAYS,
        });
    }
    if msg.round_timeout_seconds < MIN_ROUND_TIMEOUT_SECONDS
        || msg.round_timeout_seconds > MAX_ROUND_TIMEOUT_SECONDS
    {
        return Err(ContractError::InvalidRoundTimeoutSeconds {
            min: MIN_ROUND_TIMEOUT_SECONDS,
            max: MAX_ROUND_TIMEOUT_SECONDS,
        });
    }
    if !msg.ticket_price.is_zero() && msg.ticket_denom != USDC_DENOM {
        return Err(ContractError::PaidTicketMustBeUsdc {});
    }
    if !msg.ticket_price.is_zero() {
        if msg.ticket_price.u128() < MIN_PAID_TICKET_PRICE_USDC {
            return Err(ContractError::TicketPriceBelowMinimum {
                min: MIN_PAID_TICKET_PRICE_USDC,
            });
        }
        if !msg.ticket_price.u128().is_multiple_of(USDC_CENT_MICROS) {
            return Err(ContractError::TicketPriceNotWholeCents {
                cent: USDC_CENT_MICROS,
            });
        }
    }
    if msg.raffle_type != RaffleType::Airdrop && msg.max_players > MAX_PLAYERS_SINGLE_WINNER_PODIUM {
        return Err(ContractError::MaxPlayersTooHighForRaffleType {
            max: MAX_PLAYERS_SINGLE_WINNER_PODIUM,
        });
    }
    if msg.raffle_type == RaffleType::Airdrop && msg.max_players > MAX_PLAYERS_AIRDROP {
        return Err(ContractError::MaxPlayersTooHighForRaffleType {
            max: MAX_PLAYERS_AIRDROP,
        });
    }
    if msg.raffle_type == RaffleType::Podium {
        let places = msg.podium_shares_bps.len() as u32;
        // Summed as u64 (not u32) so a crafted list of huge per-entry values
        // can never wrap around to a false-positive 10000 - correctness here
        // shouldn't depend on the `overflow-checks` release profile flag.
        let sum: u64 = msg.podium_shares_bps.iter().map(|bps| *bps as u64).sum();
        let has_zero_share = msg.podium_shares_bps.contains(&0);
        if places == 0 || places > MAX_PODIUM_PLACES || sum != 10_000 || has_zero_share {
            return Err(ContractError::InvalidPodiumShares {});
        }
        if msg.min_players < places {
            return Err(ContractError::PodiumNeedsMorePlayers { needed: places });
        }
    } else if !msg.podium_shares_bps.is_empty() {
        return Err(ContractError::PodiumSharesNotApplicable {});
    }

    let factory_address = deps.api.addr_validate(&msg.factory_address)?;

    let prize_asset = match (msg.prize_native_denom, msg.prize_cw20_address) {
        (Some(denom), None) => PrizeAsset::Native { denom },
        (None, Some(addr)) => PrizeAsset::Cw20 {
            address: deps.api.addr_validate(&addr)?,
        },
        _ => {
            return Err(ContractError::Std(StdError::generic_err(
                "exactly one of prize_native_denom or prize_cw20_address must be set",
            )))
        }
    };

    // Whitelist for PAID raffles (real ticket revenue at stake up front - a
    // token must be admin-reviewed before it can be used), blacklist for
    // FREE raffles/airdrops (opt-out instead: default allowed, auto-
    // populated by `ReportCw20Failure`, see its own doc comment). A paid-
    // eligible token that later gets reported still gets caught here too -
    // whitelisted is checked together with NOT blacklisted, so
    // `ReportCw20Failure` revokes both paid and free eligibility in one
    // action instead of needing a separate "remove from whitelist" call.
    // Native denoms keep the existing 3-asset allowlist for paid raffles,
    // unrestricted for free ones - unchanged by this redesign.
    match &prize_asset {
        PrizeAsset::Native { denom } => {
            if !msg.ticket_price.is_zero() && !ALLOWED_PAID_NATIVE_PRIZE_DENOMS.contains(&denom.as_str()) {
                return Err(ContractError::PrizeAssetNotAllowlisted {});
            }
        }
        PrizeAsset::Cw20 { address } => {
            let blacklisted: bool = deps.querier.query_wasm_smart(
                &factory_address,
                &FactoryQueryMsg::IsCw20Blacklisted { address: address.to_string() },
            )?;
            if blacklisted {
                return Err(ContractError::PrizeAssetBlacklisted {});
            }
            if !msg.ticket_price.is_zero() {
                let whitelisted: bool = deps.querier.query_wasm_smart(
                    &factory_address,
                    &FactoryQueryMsg::IsCw20Whitelisted { address: address.to_string() },
                )?;
                if !whitelisted {
                    return Err(ContractError::PrizeAssetNotAllowlisted {});
                }
            }
        }
    }

    // Read once, here, and baked into this raffle's own Config for its
    // lifetime - see `Config::cancellation_penalty_base_bps`'s doc comment
    // for why this is NOT re-queried live at cancel time (that same comment
    // also has the current reasoning for why Airdrop is always 0/0 - a
    // round-7 audit fix corrected wording here that used to cite a fairness
    // check removed the same round).
    let (cancellation_penalty_base_bps, cancellation_penalty_late_additional_bps) =
        if msg.raffle_type == RaffleType::Airdrop {
            (0, 0)
        } else {
            let penalty: CancellationPenaltyResponse = deps
                .querier
                .query_wasm_smart(&factory_address, &FactoryQueryMsg::GetCancellationPenaltyBps {})?;
            (penalty.base_bps, penalty.late_additional_bps)
        };

    let fee_amount_usdc = required_fee_usdc(msg.raffle_type, msg.max_players, msg.ticket_price)?;

    let allowed_entrants = msg
        .allowed_entrants
        .map(|list| {
            list.iter()
                .map(|a| deps.api.addr_validate(a))
                .collect::<StdResult<Vec<_>>>()
        })
        .transpose()?;

    let creator = match msg.creator {
        Some(addr) => deps.api.addr_validate(&addr)?,
        None => info.sender.clone(),
    };

    let config = Config {
        creator,
        raffle_type: msg.raffle_type,
        ticket_price: msg.ticket_price,
        ticket_denom: msg.ticket_denom,
        allowed_entrants,
        min_players: msg.min_players,
        max_players: msg.max_players,
        round_timeout_seconds: msg.round_timeout_seconds,
        unclaimed_deadline_days: msg.unclaimed_deadline_days,
        prize_asset,
        fee_amount_usdc,
        usdc_denom: USDC_DENOM.to_string(),
        founder_fee_address: deps.api.addr_validate(FOUNDER_FEE_ADDRESS)?,
        treasury_address: deps.api.addr_validate(TREASURY_ADDRESS)?,
        factory_address,
        podium_shares_bps: msg.podium_shares_bps,
        cancellation_penalty_base_bps,
        cancellation_penalty_late_additional_bps,
    };
    CONFIG.save(deps.storage, &config)?;

    RAFFLE.save(
        deps.storage,
        &RaffleState {
            status: RaffleStatus::Funding,
            entrants: vec![],
            unique_players: vec![],
            ticket_revenue: Uint128::zero(),
            prize_amount: Uint128::zero(),
            fee_amount: Uint128::zero(),
            fee_paid: false,
            opened_at: None,
            closed_at: None,
            deadline: None,
            closed_at_height: None,
            commit_used: None,
            revealed_preimage: None,
            expire_requested_at_height: None,
            expiry_pending_since_height: None,
            drawn_at: None,
            winners: vec![],
            prize_shares: vec![],
            prize_paid: vec![],
            airdrop_share: Uint128::zero(),
            reclaimed: false,
            prize_transfer_failures: 0,
            prize_blocked: false,
        },
    )?;

    Ok(Response::new()
        .add_attribute("action", "instantiate")
        .add_attribute("creator", config.creator))
}

#[entry_point]
pub fn execute(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    msg: ExecuteMsg,
) -> Result<Response, ContractError> {
    match msg {
        ExecuteMsg::DepositPrize {} => execute_deposit_prize(deps, env, info),
        ExecuteMsg::PayServiceFee {} => execute_pay_service_fee(deps, info),
        ExecuteMsg::Receive(wrapper) => execute_receive(deps, env, info, wrapper),
        ExecuteMsg::BuyTicket {} => execute_buy_ticket(deps, env, info),
        ExecuteMsg::WithdrawTicket {} => execute_withdraw_ticket(deps, info),
        ExecuteMsg::CloseRound {} => execute_close_round(deps, env, info),
        ExecuteMsg::RevealDraw { preimage } => execute_reveal_draw(deps, env, preimage),
        ExecuteMsg::RequestExpireClosedRaffle {} => execute_request_expire_closed_raffle(deps, env),
        ExecuteMsg::FinalizeExpireClosedRaffle {} => execute_finalize_expire_closed_raffle(deps, env),
        ExecuteMsg::ClaimExpiredRaffle {} => claim_expired_raffle(deps, env),
        ExecuteMsg::RetryPrizePayout {} => execute_retry_prize_payout(deps, info),
        ExecuteMsg::ClaimAirdropShare {} => execute_claim_airdrop_share(deps, info),
        ExecuteMsg::ReclaimUnclaimed {} => execute_reclaim_unclaimed(deps, env, info),
        ExecuteMsg::CancelRaffle {} => execute_cancel_raffle(deps, info),
        ExecuteMsg::ExpireRaffle {} => execute_expire_raffle(deps, env, info),
    }
}

#[entry_point]
pub fn reply(deps: DepsMut, _env: Env, msg: Reply) -> Result<Response, ContractError> {
    reply_impl(deps, msg)
}

#[entry_point]
pub fn query(deps: Deps, env: Env, msg: QueryMsg) -> StdResult<Binary> {
    query_impl(deps, env, msg)
}
