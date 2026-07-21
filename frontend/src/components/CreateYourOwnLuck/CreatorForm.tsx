import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useWallet } from "../../contexts/WalletContext";
import { createRaffle, type CreateRaffleParams } from "../../lib/createRaffle";
import { displayNumberToUluna } from "../../lib/format";

// Testnet stand-in for USDC everywhere else in this app (see lib/format.ts) -
// same convention here: ticket price and prize are both denominated in this,
// always labeled USDC/USTC in the UI, never shown as "uluna"/"LUNC".
const TICKET_DENOM = "uluna";
const PRIZE_DENOM = "uluna";

// Fixed at 3 places for now - the contract supports up to 10, but a
// dynamic add/remove UI isn't needed until a creator actually asks for
// more than 3 podium places.
const DEFAULT_PODIUM_SHARES = [50, 30, 20];

type RaffleType = CreateRaffleParams["raffleType"];

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
  const [podiumShares, setPodiumShares] = useState<string[]>(
    DEFAULT_PODIUM_SHARES.map(String)
  );

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdAddress, setCreatedAddress] = useState<string | null>(null);

  function validate(): string | null {
    const price = Number(ticketPrice);
    if (!Number.isFinite(price) || price <= 0) return t("createYourOwnLuck.form.errorPrice");

    const min = Number(minPlayers);
    const max = Number(maxPlayers);
    if (!Number.isInteger(min) || min < 2) return t("createYourOwnLuck.form.errorMinPlayers");
    if (!Number.isInteger(max) || max < min) return t("createYourOwnLuck.form.errorMaxPlayers");
    const limit = maxPlayersLimit(raffleType);
    if (max > limit) return t("createYourOwnLuck.form.errorMaxPlayersLimit", { limit });

    if (raffleType === "podium") {
      const shares = podiumShares.map(Number);
      const allValid = shares.every((s) => Number.isInteger(s) && s > 0);
      const sum = shares.reduce((total, s) => total + s, 0);
      if (!allValid || sum !== 100) return t("createYourOwnLuck.form.errorPodiumShares");
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
    setCreatedAddress(null);
    try {
      const { raffleAddress } = await createRaffle(walletState.wallet, {
        raffleType,
        ticketPriceAmount: displayNumberToUluna(Number(ticketPrice)),
        ticketDenom: TICKET_DENOM,
        minPlayers: Number(minPlayers),
        maxPlayers: Number(maxPlayers),
        prizeNativeDenom: PRIZE_DENOM,
        podiumSharesBps: raffleType === "podium" ? podiumShares.map((s) => Number(s) * 100) : [],
      });
      setCreatedAddress(raffleAddress ?? null);
      onCreated?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("createYourOwnLuck.form.errorGeneric"));
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
              {(["single_winner", "podium", "airdrop"] as RaffleType[]).map((type) => (
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

          {raffleType === "podium" && (
            <label className="cyol-field">
              <span>{t("createYourOwnLuck.form.podiumSharesLabel")}</span>
              <div className="cyol-podium-shares">
                {podiumShares.map((share, i) => (
                  <input
                    key={i}
                    type="number"
                    min="1"
                    max="100"
                    value={share}
                    onChange={(e) => {
                      const next = [...podiumShares];
                      next[i] = e.target.value;
                      setPodiumShares(next);
                    }}
                  />
                ))}
              </div>
            </label>
          )}

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
