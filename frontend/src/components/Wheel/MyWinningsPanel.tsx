import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useWallet } from "../../contexts/WalletContext";
import { useMyWinnings } from "../../hooks/useMyWinnings";
import { useMyRefunds } from "../../hooks/useMyRefunds";
import { usePollWhileClosed } from "../../hooks/usePollWhileClosed";
import { ulunaToDisplayNumber } from "../../lib/format";
import { reclaimTicket } from "../../lib/roundActions";
import { isRevealed } from "../../lib/revealCache";
import { WHEEL_MANAGER_ADDRESS } from "../../lib/deployment";
import { RedeemBox } from "./RedeemBox";

type MyWinningsPanelProps = {
  redemptionDenom: string;
  // Refund per ticket for the "tickets to reclaim" list below - ReclaimTicket
  // itself refunds at the contract's current config.ticket_price.
  ticketPrice: string;
  unclaimedDeadlineDays: number;
  contractAddress?: string;
  onRedeemed?: () => void;
  // Not read directly - just forces a re-render when a reveal just happened
  // elsewhere (see revealCache/WheelCard's onRevealed), since isRevealed()
  // reads localStorage directly and nothing else would tell this component
  // to re-check it.
  revealVersion?: number;
  // The round WheelCard is currently displaying - excluded here even once
  // revealed, since WheelCard already shows its own Redeem box for it right
  // there. Once the wallet navigates away (e.g. "Continue to next round"),
  // this stops matching and the entry reappears here as normal.
  currentRoundId?: number | null;
  onReclaimed?: () => void;
};

// Surfaces any past win a wallet hasn't fully redeemed yet, regardless of
// which round the rest of the page currently happens to be viewing - a
// wallet doesn't need to keep a specific round "pinned" (e.g. right after
// watching the reveal) to come back later and redeem it. A win this wallet
// hasn't actually watched get revealed on the wheel yet (e.g. it connected
// after someone else already drew the winner) is left out of this list
// entirely, not shown with a different button - the mere presence of an
// amount here already spoils the surprise regardless of what the button
// says, so nothing about an unrevealed win surfaces anywhere until the
// wheel itself has shown it.
//
// Also lists expired rounds where this wallet still has ticket money to
// reclaim (see useMyRefunds) - no spoiler concern there, so no reveal gate.
// The panel as a whole still only renders when at least one list has
// something in it.
export function MyWinningsPanel({
  redemptionDenom,
  ticketPrice,
  unclaimedDeadlineDays,
  contractAddress,
  onRedeemed,
  currentRoundId,
  onReclaimed,
}: MyWinningsPanelProps) {
  const { t } = useTranslation();
  const { state: walletState } = useWallet();
  const address = walletState.status === "connected" ? walletState.address : null;
  const winnings = useMyWinnings(address, contractAddress);
  const refunds = useMyRefunds(address, contractAddress, currentRoundId ?? null);
  const [reclaimingRound, setReclaimingRound] = useState<number | null>(null);
  const [reclaimError, setReclaimError] = useState<string | null>(null);
  // A failed refunds read would otherwise just hide the list silently -
  // retry, same as the round/entrants reads in WheelOfRepeg.
  usePollWhileClosed(refunds.status === "error", refunds.refetch, 5000);
  // Lets handleReclaim tell whether the wallet was switched while its tx
  // was pending - its follow-up refetches belong to the old wallet then.
  const addressRef = useRef(address);
  useEffect(() => {
    addressRef.current = address;
  }, [address]);

  if (!address) return null;

  const revealedWinnings =
    winnings.status === "loaded"
      ? winnings.winnings.filter(
          (entry) =>
            entry.round_id !== currentRoundId &&
            isRevealed(contractAddress ?? WHEEL_MANAGER_ADDRESS, entry.round_id, address)
        )
      : [];
  // The round WheelCard is showing is left out for the same reason as
  // winnings above - its own Reclaim button is already right there.
  const pendingRefunds =
    refunds.status === "loaded" ? refunds.refunds.filter((r) => r.round_id !== currentRoundId) : [];
  if (revealedWinnings.length === 0 && pendingRefunds.length === 0) return null;

  async function handleReclaim(roundId: number) {
    if (walletState.status !== "connected") return;
    const reclaimAddress = walletState.address;
    setReclaimingRound(roundId);
    setReclaimError(null);
    try {
      await reclaimTicket(walletState.wallet, roundId, contractAddress);
      if (addressRef.current !== reclaimAddress) return;
      refunds.refetch();
      onReclaimed?.();
    } catch (err) {
      if (addressRef.current !== reclaimAddress) return;
      setReclaimError(err instanceof Error ? err.message : t("wheel.actionFailed"));
      refunds.refetch();
    } finally {
      setReclaimingRound(null);
    }
  }

  return (
    <div className="my-winnings-border pixel-stepped-corners">
      <div className="my-winnings-highlight pixel-stepped-corners">
        <section className="my-winnings-panel pixel-stepped-corners">
          {revealedWinnings.length > 0 && (
          <div className="my-winnings-group">
          <h2 className="my-winnings-title">
            <img src="/wheel-pixel/trophy-icon.png" alt="" className="prize-label-icon" />
            {t("myWinnings.title")}
          </h2>
          {revealedWinnings.map((entry) => (
            <div key={entry.round_id} className="my-winnings-entry">
              <p className="my-winnings-round-label">
                {t("myWinnings.roundLabel", { roundId: entry.round_id })}
              </p>
              <p className="my-winnings-amount">
                {t("myWinnings.amount", {
                  amount: ulunaToDisplayNumber(entry.prize_remaining).toFixed(2),
                })}
              </p>
              <RedeemBox
                roundId={entry.round_id}
                redemptionDenom={redemptionDenom}
                prizeRemainingUluna={entry.prize_remaining}
                unclaimedDeadlineDays={unclaimedDeadlineDays}
                contractAddress={contractAddress}
                onRedeemed={() => {
                  winnings.refetch();
                  onRedeemed?.();
                }}
              />
            </div>
          ))}
          </div>
          )}
          {pendingRefunds.length > 0 && (
            <div className="my-winnings-group">
              <h2 className="my-winnings-title">{t("myWinnings.refundsTitle")}</h2>
              {pendingRefunds.map((entry) => (
                <div key={entry.round_id} className="my-winnings-entry">
                  <p className="my-winnings-round-label">
                    {t("myWinnings.refundLabel", { roundId: entry.round_id, count: entry.ticket_count })}
                  </p>
                  <p className="my-winnings-amount">
                    {t("myWinnings.amount", {
                      amount: ulunaToDisplayNumber(
                        (BigInt(ticketPrice) * BigInt(entry.ticket_count)).toString()
                      ).toFixed(2),
                    })}
                  </p>
                  <button
                    className="round-action-btn"
                    onClick={() => handleReclaim(entry.round_id)}
                    disabled={reclaimingRound !== null}
                  >
                    {reclaimingRound === entry.round_id ? t("wheel.reclaiming") : t("wheel.reclaimTicket")}
                  </button>
                </div>
              ))}
              {reclaimError && <p className="round-action-error">{reclaimError}</p>}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
