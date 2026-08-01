import { useTranslation } from "react-i18next";
import { useWallet } from "../../contexts/WalletContext";
import { useMyWeeklyWinnings } from "../../hooks/useMyWeeklyWinnings";
import { ulunaToDisplayNumber } from "../../lib/format";
import { isRevealed } from "../../lib/revealCache";
import { redeemWeekly } from "../../lib/roundActions";
import { WEEKLY_ROUND_ADDRESS } from "../../lib/deployment";
import { RedeemBox } from "../Wheel/RedeemBox";

type MyWeeklyWinningsPanelProps = {
  redemptionDenom: string;
  unclaimedDeadlineDays: number;
  contractAddress?: string;
  onRedeemed?: () => void;
  revealVersion?: number;
  currentWeekId?: number | null;
};

// Weekly Round counterpart to MyWinningsPanel - same anti-spoiler rule
// applies (see that component's comment): a win this wallet hasn't watched
// get revealed on the wheel itself doesn't appear here at all.
export function MyWeeklyWinningsPanel({
  redemptionDenom,
  unclaimedDeadlineDays,
  contractAddress,
  onRedeemed,
  currentWeekId,
}: MyWeeklyWinningsPanelProps) {
  const { t } = useTranslation();
  const { state: walletState } = useWallet();
  const address = walletState.status === "connected" ? walletState.address : null;
  const winnings = useMyWeeklyWinnings(address, contractAddress);

  if (!address || winnings.status !== "loaded") return null;

  const revealedWinnings = winnings.winnings.filter(
    (entry) =>
      entry.week_id !== currentWeekId &&
      isRevealed(contractAddress ?? WEEKLY_ROUND_ADDRESS, entry.week_id, address)
  );
  if (revealedWinnings.length === 0) return null;

  return (
    <div className="my-winnings-border pixel-stepped-corners">
      <div className="my-winnings-highlight pixel-stepped-corners">
        <section className="my-winnings-panel pixel-stepped-corners">
          <h2 className="my-winnings-title">
            <img src="/wheel-pixel/trophy-icon.png" alt="" className="prize-label-icon" />
            {t("myWinnings.title")}
          </h2>
          {revealedWinnings.map((entry) => (
            <div key={entry.week_id} className="my-winnings-entry">
              <p className="my-winnings-round-label">
                {t("myWinnings.roundLabel", { roundId: entry.week_id })}
              </p>
              <p className="my-winnings-amount">
                {t("myWinnings.amount", {
                  amount: ulunaToDisplayNumber(entry.prize_remaining).toFixed(2),
                })}
              </p>
              <RedeemBox
                roundId={entry.week_id}
                redemptionDenom={redemptionDenom}
                prizeRemainingUluna={entry.prize_remaining}
                unclaimedDeadlineDays={unclaimedDeadlineDays}
                contractAddress={contractAddress}
                redeemAction={redeemWeekly}
                onRedeemed={() => {
                  winnings.refetch();
                  onRedeemed?.();
                }}
              />
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}
