import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useWallet } from "../../contexts/WalletContext";
import { createRaffle, type CreateRaffleParams } from "../../lib/createRaffle";
import { displayNumberToUluna } from "../../lib/format";
import { friendlyCyolError } from "../../lib/cyolErrorMessages";
import { worstCaseTicketRevenueProfit, requiredFeeUsdc, maxEntrants, maxTicketsPerWallet } from "../../lib/cyolFundingDisclosure";
import { PRIZE_ASSET_CHOICES, PRIZE_ASSET_DENOMS, PRIZE_ASSET_LABELS, type PrizeAssetChoice } from "../../lib/cyolPrizeDenoms";
import { useTokenPrices } from "../../hooks/useTokenPrices";
import { priceForAsset } from "../../lib/tokenPrices";
import { participantsWord } from "../../lib/cyolTerminology";
import { setCachedPrizeAssetChoice } from "../../lib/cyolPrizeAssetCache";

// The contract hardcodes USDC_DENOM (contracts/create-your-own-luck/src/
// contract.rs) as the only denom it accepts for any paid raffle's
// ticket_price and service fee. Set to "uluna" for now (2026-07-23) - same
// testnet stand-in convention Wheel Manager/Weekly Round already use for
// "USDC" (real USDC has no liquidity on rebel-2; an earlier "utestusdc"
// placeholder turned out to have zero supply anywhere on chain, so nobody
// could ever actually pay it) - swap for the real USDC IBC denom before
// mainnet, same as every other testnet placeholder in this app.
const TICKET_DENOM = "uluna";

// Podium is deliberately not offered here yet (2026-07-23): a creator with
// 3+ wallets can sweep multiple podium places, a known-open finding (#4 in
// the security catalog) with no reputation/transparency mitigation built in
// the UI yet. Re-add once that exists - the contract itself already
// supports it fully, this is a UI-only exclusion.

type RaffleType = Exclude<CreateRaffleParams["raffleType"], "podium">;

// Mirrors contracts/create-your-own-luck-factory's MAX_PLAYERS_SINGLE_WINNER_PODIUM
// and AIRDROP_FEE_TIERS_USDC exactly (contracts/create-your-own-luck/src/
// contract.rs) - SingleWinner/Podium are capped at 100 max_players, while
// Airdrop can go up to 1000 but the service fee (paid later, via
// DepositPrize/PayServiceFee) scales with the ceiling chosen here. The
// contract enforces both server-side regardless, but validating client-side
// avoids a creator paying gas for a signed tx that's guaranteed to be
// rejected on-chain.
const MAX_PLAYERS_SINGLE_WINNER_PODIUM = 100;
const AIRDROP_FEE_TIERS_USDC: [number, number][] = [
  [100, 3],
  [300, 7],
  [600, 12],
  [1000, 18],
];
const MAX_PLAYERS_AIRDROP = AIRDROP_FEE_TIERS_USDC[AIRDROP_FEE_TIERS_USDC.length - 1][0];

function maxPlayersLimit(raffleType: RaffleType): number {
  return raffleType === "airdrop" ? MAX_PLAYERS_AIRDROP : MAX_PLAYERS_SINGLE_WINNER_PODIUM;
}

// Free (ticket_price=0) uses the community-size tier table; a paid Airdrop
// uses the same 1%-of-max-potential-revenue formula as SingleWinner/Podium
// instead (mirrors contract.rs's required_fee_usdc exactly - it branches on
// ticket_price.is_zero(), not on raffle type). The form's own price field
// defaults Airdrop to $0, so this only diverges from the tier table if the
// creator types a manual price.
function airdropFeeForMaxPlayers(max: number, ticketPriceUsdc: number): number | null {
  if (ticketPriceUsdc > 0) {
    return max <= MAX_PLAYERS_AIRDROP ? requiredFeeUsdc("airdrop", max, ticketPriceUsdc) : null;
  }
  const tier = AIRDROP_FEE_TIERS_USDC.find(([cap]) => max <= cap);
  return tier ? tier[1] : null;
}

// Light client-side shape check only - the contract re-validates every
// address for real via addr_validate at instantiate time. This just avoids
// wasting gas on a signed tx that's guaranteed to be rejected for a typo.
// Bech32's data alphabet excludes 1/b/i/o (visually ambiguous with l/1,
// 8/b, l/1, 0/o) - accepting them here would let an obvious typo through.
const ADDRESS_PATTERN = /^terra1[ac-hj-np-z02-9]{38}$/;

// Returns null for "no whitelist" (empty input - anyone can enter), or the
// deduplicated list of addresses (a repeated address is still only one
// wallet that can ever buy a ticket - counting it twice would let a
// duplicate satisfy min_players without a second real entrant). Throws with
// the 1-based physical line number if any entry doesn't look like a valid
// address.
function parseAllowedEntrants(text: string): string[] | null {
  const rawLines = text.split("\n");
  const entries: string[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    const trimmed = rawLines[i].trim();
    if (trimmed.length === 0) continue;
    if (!ADDRESS_PATTERN.test(trimmed)) throw new Error(String(i + 1));
    entries.push(trimmed);
  }
  if (entries.length === 0) return null;
  return [...new Set(entries)];
}

// Non-throwing unique-line count for the live hints below, shown while
// typing (before every line necessarily looks like a valid address yet) -
// format validation only happens on submit, via parseAllowedEntrants above.
// Deduplicated for the same reason as parseAllowedEntrants.
function countEntrantLines(text: string): number {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return new Set(lines).size;
}

// "mode" replaces the old in-form "Raffle type" radio (single_winner vs
// airdrop) - split into 2 separate tools on CreatorToolsPage.tsx (direct
// request, 2026-08-20): an Airdrop has no winner, so grouping it under
// "raffle type" alongside SingleWinner misrepresented it as a kind of
// raffle, the same "no winner = wrong words" principle cyolTerminology.ts
// already applies to players/participants and Drawn/Executed. Podium stays
// excluded from the UI either way (see the comment above) - if it returns,
// it becomes a second option WITHIN raffle mode, not a 3rd top-level mode,
// since Podium (unlike Airdrop) is still a real raffle.
export function CreatorForm({ mode, onCreated }: { mode: "raffle" | "airdrop"; onCreated?: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { state: walletState } = useWallet();
  const [open, setOpen] = useState(false);
  const tokenPrices = useTokenPrices();

  const raffleType: RaffleType = mode === "airdrop" ? "airdrop" : "single_winner";
  // Each mode's own sensible default - Airdrop defaults to free (0),
  // SingleWinner needs a real ticket price (this form doesn't offer a free
  // path for it yet). Used to live in the type radio's onChange; mode is
  // now fixed for this component instance's whole lifetime, so the initial
  // state value alone covers it.
  const [ticketPrice, setTicketPrice] = useState(mode === "airdrop" ? "0" : "1");
  const [minPlayers, setMinPlayers] = useState("2");
  const [maxPlayers, setMaxPlayers] = useState("10");
  const [allowedEntrantsText, setAllowedEntrantsText] = useState("");
  const [prizeAssetChoice, setPrizeAssetChoice] = useState<PrizeAssetChoice>("usdc");
  // Purely a planning aid, carried forward to the Fund screen (see
  // RaffleDetailPage) - the prize amount isn't part of Instantiate at all
  // (DepositPrize, a separate later tx, is what actually commits real
  // funds), so this never gets sent in CreateRaffle's own message. Only
  // shown for SingleWinner (2026-07-25, user's call) - Airdrop's prize
  // funds a split among however many wallets end up joining, so a single
  // "planned" number doesn't mean the same thing upfront the way it does
  // for a single winner's prize.
  const [plannedPrizeAmount, setPlannedPrizeAmount] = useState("100");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function validate(): string | null {
    const price = Number(ticketPrice);
    // Airdrop can be free (ticket_price = 0, the contract's own zero-fee
    // free-raffle path) - SingleWinner can't, this form doesn't offer a
    // free path for it yet.
    if (!Number.isFinite(price) || price < 0) return t("createYourOwnLuck.form.errorPrice");
    if (raffleType !== "airdrop" && price <= 0) return t("createYourOwnLuck.form.errorPrice");
    if (price > 0) {
      // Mirrors the contract's own TicketPriceBelowMinimum/TicketPriceNotWholeCents
      // checks exactly (same rounding displayNumberToUluna will actually send),
      // so a bad price gets caught here instead of wasting gas on a signed,
      // guaranteed-to-be-rejected transaction. Only applies once a price is
      // actually being charged - a free raffle has nothing to validate here.
      const priceMicros = Number(displayNumberToUluna(price));
      if (priceMicros < 1_000_000) return t("createYourOwnLuck.form.errorPriceMinimum");
      if (priceMicros % 10_000 !== 0) return t("createYourOwnLuck.form.errorPriceCents");
    }

    const min = Number(minPlayers);
    const max = Number(maxPlayers);
    const unit = participantsWord(raffleType);
    if (!Number.isInteger(min) || min < 2) return t("createYourOwnLuck.form.errorMinPlayers", { unit });
    if (!Number.isInteger(max) || max < min) return t("createYourOwnLuck.form.errorMaxPlayers", { unit });
    const limit = maxPlayersLimit(raffleType);
    if (max > limit) return t("createYourOwnLuck.form.errorMaxPlayersLimit", { limit, unit });

    let allowedEntrants: string[] | null;
    try {
      allowedEntrants = parseAllowedEntrants(allowedEntrantsText);
    } catch (err) {
      return t("createYourOwnLuck.form.errorAllowedEntrants", {
        line: err instanceof Error ? err.message : allowedEntrantsText,
      });
    }
    // A shorter whitelist than min_players means the raffle can never reach
    // it - only the listed wallets can ever buy a ticket, so unique player
    // count is capped at the list's length no matter how long it's open.
    // The contract doesn't reject this itself (it'd just sit until
    // ExpireRaffle refunds everyone), so this is worth catching up front.
    if (allowedEntrants !== null && allowedEntrants.length < min) {
      return t("createYourOwnLuck.form.errorAllowedEntrantsBelowMinimum", {
        count: allowedEntrants.length,
        min,
        unit,
      });
    }

    return null;
  }

  async function handleSubmit() {
    if (walletState.status !== "connected") return;
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const { raffleAddress } = await createRaffle(walletState.wallet, {
        raffleType,
        ticketPriceAmount: displayNumberToUluna(Number(ticketPrice)),
        ticketDenom: TICKET_DENOM,
        minPlayers: Number(minPlayers),
        maxPlayers: Number(maxPlayers),
        prizeNativeDenom: PRIZE_ASSET_DENOMS[prizeAssetChoice],
        podiumSharesBps: [],
        allowedEntrants: parseAllowedEntrants(allowedEntrantsText),
      });
      // Straight to funding this specific raffle - landing back on the full
      // listing left the creator guessing which "Funding" card was theirs,
      // especially once several raffles exist at once. Navigate first, and
      // isolate onCreated in its own try/catch - if it throws, that must
      // not be mistaken for the transaction itself failing after it
      // already succeeded (only the raffle address is proof of that).
      if (raffleAddress) {
        // Cached (not just passed via router state) so the funding screen's
        // value-mismatch warnings and safety checklist price this raffle's
        // prize correctly even on a reload or a later revisit, not just
        // immediately after creating it - real gap found live-testing
        // 2026-07-26 (a LUNC-chosen prize silently priced as USDC on
        // revisit, defeating the safety warning meant to catch exactly
        // that). Still testnet-only - see cyolPrizeAssetCache.ts.
        setCachedPrizeAssetChoice(raffleAddress, prizeAssetChoice);
        navigate(`/create-your-own-luck/${raffleAddress}`, {
          state: raffleType === "single_winner" ? { plannedPrizeAmount } : undefined,
        });
      }
      try {
        onCreated?.();
      } catch {
        // Best-effort list refresh - a failure here doesn't affect the
        // raffle that was just created.
      }
    } catch (err) {
      setError(err instanceof Error ? friendlyCyolError(err.message) : t("createYourOwnLuck.form.errorGeneric"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="cyol-creator">
      <button type="button" className="cyol-creator-toggle" onClick={() => setOpen((o) => !o)}>
        {t(mode === "airdrop" ? "createYourOwnLuck.creatorToggleAirdrop" : "createYourOwnLuck.creatorToggle")}{" "}
        {open ? "▲" : "▼"}
      </button>

      {/* Pitch for whoever hasn't opened the form yet - gone once they have,
          so it doesn't compete with the real fields for space (direct
          request, 2026-08-20). */}
      {!open && (
        <p className="cyol-creator-intro">
          {t(mode === "airdrop" ? "createYourOwnLuck.creatorIntroAirdrop" : "createYourOwnLuck.creatorIntroRaffle")}
        </p>
      )}

      {open && (
        <div className="cyol-creator-form">
          <label className="cyol-field">
            <span>{t("createYourOwnLuck.form.ticketPriceLabel")}</span>
            <input
              type="number"
              min="0"
              step="0.01"
              value={ticketPrice}
              onChange={(e) => setTicketPrice(e.target.value)}
            />
          </label>

          <label className="cyol-field">
            <span>{t("createYourOwnLuck.form.minPlayersLabel", { unit: participantsWord(raffleType) })}</span>
            <input
              type="number"
              min="2"
              value={minPlayers}
              onChange={(e) => setMinPlayers(e.target.value)}
            />
          </label>

          <label className="cyol-field">
            <span>
              {t("createYourOwnLuck.form.maxPlayersLabel", {
                limit: maxPlayersLimit(raffleType),
                unit: participantsWord(raffleType),
              })}
            </span>
            <input
              type="number"
              min="2"
              max={maxPlayersLimit(raffleType)}
              value={maxPlayers}
              onChange={(e) => setMaxPlayers(e.target.value)}
            />
            {raffleType === "airdrop" &&
              (() => {
                const fee = airdropFeeForMaxPlayers(Number(maxPlayers), Number(ticketPrice));
                return fee !== null ? (
                  <span className="cyol-hint">
                    {t("createYourOwnLuck.form.airdropFeeNote", { fee: fee.toFixed(2) })}
                  </span>
                ) : null;
              })()}
          </label>

          <label className="cyol-field">
            <span>{t("createYourOwnLuck.form.prizeAssetLabel")}</span>
            <div className="cyol-radio-group">
              {PRIZE_ASSET_CHOICES.map((choice) => (
                <label key={choice} className="cyol-radio">
                  <input
                    type="radio"
                    // Scoped by mode - CreatorToolsPage now renders both a
                    // "raffle" and an "airdrop" CreatorForm on the same page
                    // at once (2026-08-20 split); a fixed "prizeAsset" name
                    // would make the browser treat their 2 radio groups as
                    // one, so picking an asset in one form could silently
                    // deselect the other's.
                    name={`prizeAsset-${mode}`}
                    checked={prizeAssetChoice === choice}
                    onChange={() => setPrizeAssetChoice(choice)}
                  />
                  {PRIZE_ASSET_LABELS[choice]}
                </label>
              ))}
            </div>
            <span className="cyol-hint">{t("createYourOwnLuck.form.prizeAssetHint")}</span>
            {prizeAssetChoice === "lunc" && (
              // CodeRabbit finding (2026-07-26): LUNC and USDC serialize to
              // the exact same testnet denom (see cyolPrizeDenoms.ts) - a
              // creator picking LUNC deserves to know it won't actually
              // behave any differently from USDC until mainnet, rather than
              // silently getting USDC's behavior.
              <span className="cyol-hint">{t("createYourOwnLuck.form.prizeAssetLuncTestnetHint")}</span>
            )}
          </label>

          <label className="cyol-field">
            <span>{t("createYourOwnLuck.form.allowedEntrantsLabel")}</span>
            <textarea
              className="cyol-textarea"
              rows={4}
              placeholder="terra1..."
              value={allowedEntrantsText}
              onChange={(e) => setAllowedEntrantsText(e.target.value)}
            />
            <span className="cyol-hint">{t("createYourOwnLuck.form.allowedEntrantsHint")}</span>
            {(() => {
              const count = countEntrantLines(allowedEntrantsText);
              if (count === 0) return null;
              const min = Number(minPlayers);
              const max = Number(maxPlayers);
              if (count < min) {
                return (
                  <span className="cyol-hint">
                    {t("createYourOwnLuck.form.allowedEntrantsBelowMinimumHint", { count, min, unit: participantsWord(raffleType) })}
                  </span>
                );
              }
              if (count > max) {
                return (
                  <span className="cyol-hint">
                    {t("createYourOwnLuck.form.allowedEntrantsExceedsMaxHint", { count, max })}
                  </span>
                );
              }
              return null;
            })()}
          </label>

          {raffleType === "single_winner" && (
            <label className="cyol-field">
              <span>{t("createYourOwnLuck.form.plannedPrizeLabel", { asset: PRIZE_ASSET_LABELS[prizeAssetChoice] })}</span>
              <input
                type="number"
                min="0"
                step="0.01"
                value={plannedPrizeAmount}
                onChange={(e) => setPlannedPrizeAmount(e.target.value)}
              />
              <span className="cyol-hint">{t("createYourOwnLuck.form.plannedPrizeHint")}</span>
              {(() => {
                const price = Number(ticketPrice);
                const max = Number(maxPlayers);
                const prize = Number(plannedPrizeAmount);
                // Mirrors validate()'s own constraints (price > 0 for
                // SingleWinner, integer max_players) - without this, typing
                // an invalid value still in progress (a negative price, a
                // fractional max_players) showed a disclosure number for an
                // input that submit would reject anyway (CodeRabbit finding,
                // 2026-07-26).
                if (
                  !Number.isFinite(price) ||
                  price <= 0 ||
                  !Number.isFinite(max) ||
                  !Number.isInteger(max) ||
                  max < 2 ||
                  !Number.isFinite(prize) ||
                  prize < 0 ||
                  tokenPrices.status !== "loaded"
                ) {
                  return null;
                }
                // The prize amount is in whatever asset was chosen above,
                // not necessarily USDC - convert to real USD before
                // comparing against ticket revenue (also in USDC, the only
                // denom a paid ticket can use). Uses the real chosen asset
                // (priceForAsset), not a denom lookup - "uluna" alone can't
                // tell LUNC and USDC apart, but this form knows exactly
                // which one the creator picked (real bug found live,
                // 2026-07-26: LUNC was silently priced as USDC otherwise).
                const prizeUsd = prize * priceForAsset(prizeAssetChoice, tokenPrices.prices);
                const profit = worstCaseTicketRevenueProfit("single_winner", max, price, prizeUsd);
                return (
                  <span className="cyol-hint">
                    {profit > 0
                      ? t("createYourOwnLuck.form.fundraiserDisclosurePositive", { amount: profit.toFixed(2) })
                      : t("createYourOwnLuck.form.fundraiserDisclosureNegative", { amount: Math.abs(profit).toFixed(2) })}
                  </span>
                );
              })()}
            </label>
          )}

          {/* Creator calculator - only meaningful once real money is on the
              line (a free raffle has no fee-vs-revenue tension to plan
              around). Airdrop's prize isn't known until DepositPrize, so its
              break-even here only covers the service fee, not the
              (yet-unknown) prize on top of it - SingleWinner already has a
              real planned prize in this same form to fold in. */}
          {Number(ticketPrice) > 0 &&
            (() => {
              const price = Number(ticketPrice);
              const max = Number(maxPlayers);
              // Mirrors validate()'s own constraints exactly (CodeRabbit
              // finding, 2026-07-26) - minimum price and whole-cent rule,
              // and max_players within this raffle type's real ceiling -
              // without these, a value still invalid by submission's own
              // rules showed calculator numbers for an input that would be
              // rejected anyway.
              if (
                !Number.isFinite(price) ||
                price <= 0 ||
                !Number.isFinite(max) ||
                !Number.isInteger(max) ||
                max < 2 ||
                max > maxPlayersLimit(raffleType)
              ) {
                return null;
              }
              const priceMicros = Number(displayNumberToUluna(price));
              if (priceMicros < 1_000_000 || priceMicros % 10_000 !== 0) return null;

              const maxTickets = maxEntrants(raffleType, max);
              const maxRevenue = price * maxTickets;
              const fee = requiredFeeUsdc(raffleType, max, price);
              const effectiveFeeRate = maxRevenue > 0 ? (fee / maxRevenue) * 100 : 0;

              const plannedPrizeNum = Number(plannedPrizeAmount);
              const prizeUsd =
                raffleType === "single_winner" &&
                tokenPrices.status === "loaded" &&
                Number.isFinite(plannedPrizeNum) &&
                plannedPrizeNum >= 0
                  ? plannedPrizeNum * priceForAsset(prizeAssetChoice, tokenPrices.prices)
                  : null;
              const costToBreakEven = prizeUsd !== null ? fee + prizeUsd : fee;
              const breakEvenTickets = Math.ceil(costToBreakEven / price);
              // Real gap found live-testing this same PR (CodeRabbit finding,
              // 2026-07-26): capping the suggestion at max_players silently
              // presented it as actionable even when break-even exceeds the
              // raffle's own maximum SELLABLE tickets (maxTickets, not just
              // max_players - a wallet can buy more than one) - that raffle
              // can never break even at these settings, no matter what
              // min_players is set to, so suggesting one was misleading.
              const breakEvenReachable = breakEvenTickets <= maxTickets;
              // Real bug found live-testing (2026-07-26): this used to cap
              // breakEvenTickets (a TICKET count) directly against max (a
              // WALLET count) as if they were the same unit - they aren't, a
              // wallet can buy up to capPerWallet tickets. That's exactly
              // why max_players=100 always suggested "100" regardless of how
              // few tickets were actually needed (e.g. a near-worthless LUNC
              // prize needing only ~50 tickets still suggested 50 *wallets*,
              // when ~1 wallet buying its full cap could realistically cover
              // that many tickets alone).
              const capPerWallet = maxTicketsPerWallet(raffleType, max);
              const neededWallets = Math.ceil(breakEvenTickets / capPerWallet);
              const suggestedMinPlayers = breakEvenReachable ? Math.min(max, Math.max(2, neededWallets)) : null;

              return (
                <div className="cyol-creator-calculator">
                  <p className="cyol-calc-title">{t("createYourOwnLuck.form.calcTitle")}</p>
                  <p className="cyol-hint">{t("createYourOwnLuck.form.calcMaxTickets", { tickets: maxTickets })}</p>
                  <p className="cyol-hint">{t("createYourOwnLuck.form.calcMaxRevenue", { revenue: maxRevenue.toFixed(2) })}</p>
                  <p className="cyol-hint">
                    {t("createYourOwnLuck.form.calcFeeRate", { fee: fee.toFixed(2), rate: effectiveFeeRate.toFixed(1) })}
                  </p>
                  <p className="cyol-hint">
                    {breakEvenReachable
                      ? t(
                          prizeUsd !== null
                            ? "createYourOwnLuck.form.calcBreakEvenWithPrize"
                            : "createYourOwnLuck.form.calcBreakEvenFeeOnly",
                          { tickets: breakEvenTickets }
                        )
                      : t("createYourOwnLuck.form.calcBreakEvenUnreachable", { maxTickets, unit: participantsWord(raffleType) })}
                  </p>
                  {breakEvenReachable && suggestedMinPlayers !== null && (
                    <button
                      type="button"
                      className="cyol-submit cyol-submit-secondary"
                      onClick={() => setMinPlayers(String(suggestedMinPlayers))}
                    >
                      {t("createYourOwnLuck.form.calcSuggestMinPlayers", { min: suggestedMinPlayers, unit: participantsWord(raffleType) })}
                    </button>
                  )}
                </div>
              );
            })()}

          {error && <p className="cyol-form-error">{error}</p>}

          <button
            type="button"
            className="cyol-submit"
            onClick={handleSubmit}
            disabled={submitting || walletState.status !== "connected"}
            title={
              walletState.status !== "connected" ? t("createYourOwnLuck.form.connectFirst") : undefined
            }
          >
            {submitting
              ? t(raffleType === "airdrop" ? "createYourOwnLuck.form.submittingAirdrop" : "createYourOwnLuck.form.submitting")
              : t(raffleType === "airdrop" ? "createYourOwnLuck.form.submitAirdrop" : "createYourOwnLuck.form.submit")}
          </button>
        </div>
      )}
    </div>
  );
}
