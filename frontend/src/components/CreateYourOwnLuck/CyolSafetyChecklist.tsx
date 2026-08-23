import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CyolConfigResponse, CyolRaffleStatusResponse } from "../../lib/queryCyolRaffle";
import { ulunaToDisplayNumber } from "../../lib/format";
import { worstCaseTicketRevenueProfit, worstCaseMinParticipationProfit } from "../../lib/cyolFundingDisclosure";
import {
  isSmallUnsafeShape,
  walletConcentration,
  concentrationBand,
  cooldownBand,
  creatorSelfBuy,
  creatorSelfBuyBand,
  UNSAFE_MAX_PLAYERS_THRESHOLD,
  type ChecklistBand,
} from "../../lib/cyolChecklist";
import { useCyolCreatorCooldown } from "../../hooks/useCyolCreatorCooldown";
import { useTokenPrices } from "../../hooks/useTokenPrices";
import { priceForDenom, priceForAsset } from "../../lib/tokenPrices";
import type { PrizeAssetChoice } from "../../lib/cyolPrizeDenoms";

// Separate signals, deliberately not a single combined score (agreed with
// the user 2026-07-25/26, see "Repeg Club - Create Your Own Luck (seguridad,
// hallazgos y exploits)") - a single bad signal must stay visible, not get
// diluted behind good ones. Player-facing: unlike the fundraiser
// disclosure's first version (creator-only, shown while creating/funding),
// this is meant for anyone deciding whether to buy a ticket, so it lives
// here rather than gated behind isCreator.
function Row({ band, children }: { band: ChecklistBand; children: React.ReactNode }) {
  const prevBand = useRef(band);
  const [flash, setFlash] = useState(false);

  useEffect(() => {
    if (prevBand.current !== band) {
      prevBand.current = band;
      setFlash(true);
      const id = setTimeout(() => setFlash(false), 900);
      return () => clearTimeout(id);
    }
  }, [band]);

  return <li className={`cyol-checklist-row cyol-checklist-${band}${flash ? " cyol-checklist-flash" : ""}`}>{children}</li>;
}

export function CyolSafetyChecklist({
  config,
  raffleStatus,
  entrants,
  prizeAssetChoiceOverride,
}: {
  config: CyolConfigResponse;
  raffleStatus: CyolRaffleStatusResponse;
  entrants: string[];
  // Real bug found live-testing (2026-07-26): a fresh raffle's prize_asset
  // denom alone can't distinguish LUNC from USDC on this testnet (both
  // "uluna" - see tokenPrices.ts's priceForDenom), so this checklist would
  // silently price a LUNC prize as USDC ($1/unit) and show a false "safe"
  // signal. RaffleDetailPage passes the creator's real choice through here
  // when it's known (right after creating this exact raffle, via router
  // state) - falls back to the denom-based guess otherwise, same
  // degradation as everywhere else this ambiguity shows up.
  prizeAssetChoiceOverride?: PrizeAssetChoice;
}) {
  const { t } = useTranslation();

  // Only meaningful before the outcome is decided - once Drawn/Cancelled the
  // player already knows what happened, and the creator can't act on any of
  // this anymore anyway.
  const active = raffleStatus.status === "funding" || raffleStatus.status === "open" || raffleStatus.status === "closed";
  const cooldownState = useCyolCreatorCooldown(config.creator, active);
  const tokenPrices = useTokenPrices();

  if (!active) return null;
  // RaffleDetailPage already excludes Podium raffles entirely before this
  // renders - this is just a type-level guard so worstCaseTicketRevenueProfit
  // below (which only knows single_winner/airdrop) stays sound.
  if (config.raffle_type === "podium") return null;

  const isAirdrop = config.raffle_type === "airdrop";
  const ticketPriceUsdc = ulunaToDisplayNumber(config.ticket_price);
  // The contract allows a paid raffle's prize to be LUNC/USDC/USTC (see
  // ALLOWED_PAID_NATIVE_PRIZE_DENOMS in contract.rs), not just USDC - mixing
  // a non-USDC prize amount into this dollar math would silently produce a
  // meaningless number (CodeRabbit finding on this PR, 2026-07-26, fixed by
  // converting through real market prices instead of assuming 1:1 USD).
  const prizeDenom = "native" in config.prize_asset ? config.prize_asset.native.denom : null;
  const prizeAssetPrice =
    prizeAssetChoiceOverride && tokenPrices.status === "loaded"
      ? priceForAsset(prizeAssetChoiceOverride, tokenPrices.prices)
      : prizeDenom && tokenPrices.status === "loaded"
        ? priceForDenom(prizeDenom, tokenPrices.prices)
        : null;
  const prizeUsdc =
    prizeAssetPrice !== null && raffleStatus.prize_amount !== "0"
      ? ulunaToDisplayNumber(raffleStatus.prize_amount) * prizeAssetPrice
      : null;

  const fundraiserProfit =
    !isAirdrop && prizeUsdc !== null
      ? worstCaseTicketRevenueProfit(config.raffle_type, config.max_players, ticketPriceUsdc, prizeUsdc)
      : null;
  const minParticipationProfit =
    !isAirdrop && prizeUsdc !== null
      ? worstCaseMinParticipationProfit(
          config.min_players,
          ticketPriceUsdc,
          prizeUsdc,
          ulunaToDisplayNumber(config.fee_amount_usdc)
        )
      : null;

  const smallShape = isSmallUnsafeShape(config.raffle_type, config.ticket_price, config.max_players);
  const concentration = walletConcentration(entrants);
  const cBand = concentrationBand(concentration);
  const selfBuy = creatorSelfBuy(entrants, config.creator);
  const selfBuyBand = creatorSelfBuyBand(selfBuy);

  return (
    <div className="cyol-checklist">
      <p className="cyol-checklist-title">{t("createYourOwnLuck.checklist.title")}</p>
      <ul className="cyol-checklist-list">
        {isAirdrop ? (
          <Row band="neutral">{t("createYourOwnLuck.checklist.fundraiserNotApplicable")}</Row>
        ) : fundraiserProfit === null || minParticipationProfit === null ? (
          <Row band="neutral">{t("createYourOwnLuck.checklist.fundraiserUnknown")}</Row>
        ) : (
          <Row band="neutral">
            {fundraiserProfit > 0
              ? t("createYourOwnLuck.checklist.fundraiserPositive", { amount: fundraiserProfit.toFixed(2) })
              : t("createYourOwnLuck.checklist.fundraiserNegative", { amount: Math.abs(fundraiserProfit).toFixed(2) })}{" "}
            {minParticipationProfit > 0
              ? t("createYourOwnLuck.checklist.minParticipationPositive", {
                  min: config.min_players,
                  amount: minParticipationProfit.toFixed(2),
                })
              : t("createYourOwnLuck.checklist.minParticipationNegative", {
                  min: config.min_players,
                  amount: Math.abs(minParticipationProfit).toFixed(2),
                })}
          </Row>
        )}

        {/* SingleWinner only - distinct from the fundraiser row above, which
            is about the creator's ticket-revenue economics. This is a
            player-facing sanity check: if the whole prize is worth less
            than a single ticket at real market prices, no odds make that a
            good bet, regardless of how the raffle's revenue nets out for
            the creator. Found live-testing 2026-07-26 (a LUNC/USTC prize
            can look like a big number while being worth very little). */}
        {!isAirdrop && (
          <Row band={prizeUsdc === null ? "neutral" : prizeUsdc < ticketPriceUsdc ? "red" : "green"}>
            {prizeUsdc === null
              ? t("createYourOwnLuck.checklist.prizeVsTicketUnknown")
              : prizeUsdc < ticketPriceUsdc
                ? t("createYourOwnLuck.checklist.prizeBelowTicketPrice", {
                    prize: prizeUsdc.toFixed(2),
                    ticket: ticketPriceUsdc.toFixed(2),
                  })
                : t("createYourOwnLuck.checklist.prizeAboveTicketPrice")}
          </Row>
        )}

        <Row band={selfBuyBand}>
          {selfBuy === null
            ? t(isAirdrop ? "createYourOwnLuck.checklist.creatorSelfBuyNoneAirdrop" : "createYourOwnLuck.checklist.creatorSelfBuyNone")
            : t(
                isAirdrop
                  ? selfBuyBand === "red"
                    ? "createYourOwnLuck.checklist.creatorSelfBuyMajorityAirdrop"
                    : "createYourOwnLuck.checklist.creatorSelfBuyMinorityAirdrop"
                  : selfBuyBand === "red"
                    ? "createYourOwnLuck.checklist.creatorSelfBuyMajority"
                    : "createYourOwnLuck.checklist.creatorSelfBuyMinority",
                { percent: Math.round(selfBuy.share * 100) }
              )}
        </Row>

        <Row band={smallShape ? "yellow" : "green"}>
          {smallShape
            ? t("createYourOwnLuck.checklist.maxPlayersSmall", {
                max: config.max_players,
                threshold: UNSAFE_MAX_PLAYERS_THRESHOLD,
              })
            : t("createYourOwnLuck.checklist.maxPlayersFine", { max: config.max_players })}
        </Row>

        <Row band={cBand}>
          {concentration === null
            ? t("createYourOwnLuck.checklist.concentrationNone")
            : t(`createYourOwnLuck.checklist.concentration${cBand === "green" ? "Green" : cBand === "yellow" ? "Yellow" : "Red"}`, {
                percent: Math.round(concentration.share * 100),
              })}
        </Row>

        <Row band={cooldownState.status === "loaded" ? cooldownBand(cooldownState.cooldown, Date.now() / 1000) : "neutral"}>
          {cooldownState.status === "loading" && t("createYourOwnLuck.checklist.cooldownLoading")}
          {cooldownState.status === "error" && t("createYourOwnLuck.checklist.cooldownUnknown")}
          {cooldownState.status === "loaded" &&
            (cooldownBand(cooldownState.cooldown, Date.now() / 1000) === "green"
              ? t("createYourOwnLuck.checklist.cooldownNone")
              : t("createYourOwnLuck.checklist.cooldownActive", { streak: cooldownState.cooldown.unsafe_streak }))}
        </Row>
      </ul>
    </div>
  );
}
