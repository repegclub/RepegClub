import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useWallet } from "../../contexts/WalletContext";
import { createRaffle, type CreateRaffleParams } from "../../lib/createRaffle";
import { displayNumberToUluna } from "../../lib/format";
import { friendlyCyolError } from "../../lib/cyolErrorMessages";

// The contract hardcodes USDC_DENOM (contracts/create-your-own-luck/src/
// contract.rs) as the only denom it accepts for any paid raffle's
// ticket_price and service fee. Set to "uluna" for now (2026-07-23) - same
// testnet stand-in convention Wheel Manager/Weekly Round already use for
// "USDC" (real USDC has no liquidity on rebel-2; an earlier "utestusdc"
// placeholder turned out to have zero supply anywhere on chain, so nobody
// could ever actually pay it) - swap for the real USDC IBC denom before
// mainnet, same as every other testnet placeholder in this app. The prize
// denom below happens to be "uluna" too here (both mean actual LUNC/USDC
// respectively, they're just the same underlying testnet token for now).
const TICKET_DENOM = "uluna";
const PRIZE_DENOM = "uluna";

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

function airdropFeeForMaxPlayers(max: number): number | null {
  const tier = AIRDROP_FEE_TIERS_USDC.find(([cap]) => max <= cap);
  return tier ? tier[1] : null;
}

export function CreatorForm({ onCreated }: { onCreated?: () => void }) {
  const { t } = useTranslation();
  const { state: walletState } = useWallet();
  const [open, setOpen] = useState(false);

  const [raffleType, setRaffleType] = useState<RaffleType>("single_winner");
  const [ticketPrice, setTicketPrice] = useState("1");
  const [minPlayers, setMinPlayers] = useState("2");
  const [maxPlayers, setMaxPlayers] = useState("10");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdAddress, setCreatedAddress] = useState<string | null>(null);

  function validate(): string | null {
    const price = Number(ticketPrice);
    if (!Number.isFinite(price) || price <= 0) return t("createYourOwnLuck.form.errorPrice");
    // Mirrors the contract's own TicketPriceBelowMinimum/TicketPriceNotWholeCents
    // checks exactly (same rounding displayNumberToUluna will actually send),
    // so a bad price gets caught here instead of wasting gas on a signed,
    // guaranteed-to-be-rejected transaction.
    const priceMicros = Number(displayNumberToUluna(price));
    if (priceMicros < 1_000_000) return t("createYourOwnLuck.form.errorPriceMinimum");
    if (priceMicros % 10_000 !== 0) return t("createYourOwnLuck.form.errorPriceCents");

    const min = Number(minPlayers);
    const max = Number(maxPlayers);
    if (!Number.isInteger(min) || min < 2) return t("createYourOwnLuck.form.errorMinPlayers");
    if (!Number.isInteger(max) || max < min) return t("createYourOwnLuck.form.errorMaxPlayers");
    const limit = maxPlayersLimit(raffleType);
    if (max > limit) return t("createYourOwnLuck.form.errorMaxPlayersLimit", { limit });

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
    setCreatedAddress(null);
    try {
      const { raffleAddress } = await createRaffle(walletState.wallet, {
        raffleType,
        ticketPriceAmount: displayNumberToUluna(Number(ticketPrice)),
        ticketDenom: TICKET_DENOM,
        minPlayers: Number(minPlayers),
        maxPlayers: Number(maxPlayers),
        prizeNativeDenom: PRIZE_DENOM,
        podiumSharesBps: [],
      });
      setCreatedAddress(raffleAddress ?? null);
      onCreated?.();
    } catch (err) {
      setError(err instanceof Error ? friendlyCyolError(err.message) : t("createYourOwnLuck.form.errorGeneric"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="cyol-creator">
      <button type="button" className="cyol-creator-toggle" onClick={() => setOpen((o) => !o)}>
        {t("createYourOwnLuck.creatorToggle")} {open ? "▲" : "▼"}
      </button>

      {open && (
        <div className="cyol-creator-form">
          <label className="cyol-field">
            <span>{t("createYourOwnLuck.form.raffleTypeLabel")}</span>
            <div className="cyol-radio-group">
              {(["single_winner", "airdrop"] as RaffleType[]).map((type) => (
                <label key={type} className="cyol-radio">
                  <input
                    type="radio"
                    name="raffleType"
                    checked={raffleType === type}
                    onChange={() => setRaffleType(type)}
                  />
                  {t(`createYourOwnLuck.raffleType.${type === "single_winner" ? "singleWinner" : type}`)}
                </label>
              ))}
            </div>
          </label>

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
            <span>{t("createYourOwnLuck.form.minPlayersLabel")}</span>
            <input
              type="number"
              min="2"
              value={minPlayers}
              onChange={(e) => setMinPlayers(e.target.value)}
            />
          </label>

          <label className="cyol-field">
            <span>
              {t("createYourOwnLuck.form.maxPlayersLabel", { limit: maxPlayersLimit(raffleType) })}
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
                const fee = airdropFeeForMaxPlayers(Number(maxPlayers));
                return fee !== null ? (
                  <span className="cyol-hint">
                    {t("createYourOwnLuck.form.airdropFeeNote", { fee })}
                  </span>
                ) : null;
              })()}
          </label>

          {error && <p className="cyol-form-error">{error}</p>}
          {createdAddress && (
            <p className="cyol-form-success">
              {t("createYourOwnLuck.form.success", { address: createdAddress })}
            </p>
          )}

          <button
            type="button"
            className="cyol-submit"
            onClick={handleSubmit}
            disabled={submitting || walletState.status !== "connected"}
            title={
              walletState.status !== "connected" ? t("createYourOwnLuck.form.connectFirst") : undefined
            }
          >
            {submitting ? t("createYourOwnLuck.form.submitting") : t("createYourOwnLuck.form.submit")}
          </button>
        </div>
      )}
    </div>
  );
}
