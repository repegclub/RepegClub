// Translates raw chain rejections (the txResponse.rawLog a failed
// broadcastTxSync throws, e.g. "...: ticket_price must be either exactly 0
// (free) or at least 1000000 USDC micros ($1) - no dust pricing in between:
// instantiate wasm contract failed [...]: unknown request") into plain
// language a non-technical creator/player can actually act on. Matched by
// stable substrings from contracts/create-your-own-luck(-factory)/src/
// error.rs's #[error(...)] text, not the full wrapped rawLog (which also
// carries wasmd/CosmWasm plumbing no player needs to see). Order matters:
// first match wins, most specific rules first.
const RULES: { test: RegExp; friendly: string }[] = [
  // Raffle creation (factory + raffle instantiate)
  { test: /ticket_price must be either exactly 0.*no dust pricing/i, friendly: "Ticket price must be either free ($0) or at least $1 — no prices in between." },
  { test: /ticket_price must be a whole number of usdc cents/i, friendly: "Ticket price can't have fractions of a cent — use at most 2 decimal places." },
  { test: /paid raffles.*must set ticket_denom to the platform's usdc/i, friendly: "Paid raffles must be priced in USDC." },
  { test: /min_players must be at least 2/i, friendly: "Minimum players must be at least 2, and maximum can't be less than the minimum." },
  { test: /max_players|maxplayersexceedsfreeraffle/i, friendly: "Maximum players is too high for this raffle type." },
  { test: /podium_shares_bps must be non-empty/i, friendly: "Podium shares must add up to exactly 100%." },
  { test: /podium raffles need min_players/i, friendly: "This raffle needs more minimum players to fit every podium place." },
  { test: /can only offer lunc, usdc, or ustc/i, friendly: "This prize isn't on the allowed list (LUNC, USDC, or USTC) for a paid raffle." },
  { test: /unclaimed_deadline_days must be between/i, friendly: "The unclaimed-funds deadline is out of the allowed range." },
  { test: /round_timeout_seconds must be between/i, friendly: "The round timeout is out of the allowed range." },
  { test: /draw_delay_blocks must be between/i, friendly: "The draw delay is out of the allowed range." },
  { test: /draw_window_blocks must be between/i, friendly: "The draw window is out of the allowed range." },
  { test: /max_raffle_age_seconds must be between/i, friendly: "The raffle's maximum age is out of the allowed range." },
  { test: /wallet is on cooldown for creating another small paid raffle/i, friendly: "You're on cooldown for creating another small paid raffle — try a free raffle, a bigger one, or wait it out." },

  // Funding
  { test: /prize amount must be greater than zero/i, friendly: "Prize amount must be greater than zero." },
  { test: /prize has already been deposited/i, friendly: "This raffle has already been funded." },
  { test: /pay payservicefee first/i, friendly: "Pay the service fee first, then fund the raffle." },
  { test: /wrong fee payment/i, friendly: "Wrong service fee amount sent." },
  { test: /this raffle's prize is a cw20 token/i, friendly: "This raffle's prize is a different kind of token — funding it isn't supported here yet." },
  { test: /unexpected denom attached/i, friendly: "You attached a token this action doesn't expect — double-check the amount and try again." },

  // Tickets
  { test: /raffle is not open/i, friendly: "This raffle isn't open for ticket sales right now." },
  { test: /already holds the maximum.*tickets allowed/i, friendly: "You've already reached the maximum tickets allowed per wallet for this raffle." },
  { test: /wrong ticket payment/i, friendly: "Wrong ticket payment amount." },
  { test: /wallet is not in the allowlist/i, friendly: "Your wallet isn't on the allowlist for this raffle." },
  { test: /no tickets to withdraw/i, friendly: "You don't have any tickets to withdraw in this raffle." },
  { test: /tickets can only be withdrawn before min_players/i, friendly: "Tickets can only be withdrawn before the raffle reaches its minimum players." },

  // Close / draw
  { test: /cannot be closed yet/i, friendly: "This raffle can't be closed yet — it hasn't reached the max players or the timeout." },
  { test: /raffle is not closed/i, friendly: "This raffle isn't closed yet." },
  { test: /cannot be drawn yet/i, friendly: "It's too early to draw this raffle — try again shortly." },
  { test: /not enough players to draw/i, friendly: "Not enough players joined to draw a winner." },

  // Airdrop
  { test: /raffle has not been drawn yet/i, friendly: "This raffle hasn't been drawn yet." },
  { test: /only for airdrop raffles/i, friendly: "This action is only for Airdrop raffles." },
  { test: /did not participate in this raffle/i, friendly: "This wallet didn't participate in this raffle." },
  { test: /already claimed its airdrop share/i, friendly: "You already claimed your share." },
  { test: /unclaimed-funds deadline has not passed/i, friendly: "It's too early to reclaim unclaimed shares — the deadline hasn't passed yet." },
  { test: /already reclaimed unclaimed funds/i, friendly: "Unclaimed shares were already reclaimed for this raffle." },

  // Cancel / expire
  { test: /already been cancelled/i, friendly: "This raffle was already cancelled." },
  { test: /cannot be cancelled once it is closed or drawn/i, friendly: "This raffle can't be cancelled anymore — it's already closed or drawn." },
  { test: /cannot be expired yet/i, friendly: "This raffle can't be expired yet — either it already reached its minimum players, or the waiting period hasn't passed." },

  // Generic / permissions
  { test: /^unauthorized$|: unauthorized:/i, friendly: "Only the raffle's creator can do that right now." },

  // Wallet / chain, not specific to this contract
  { test: /insufficient funds|insufficient balance/i, friendly: "Your wallet doesn't have enough balance to cover this." },
  { test: /request rejected|user rejected/i, friendly: "Transaction cancelled in your wallet." },
];

export function friendlyCyolError(raw: string): string {
  const match = RULES.find((rule) => rule.test.test(raw));
  return match ? match.friendly : raw;
}
