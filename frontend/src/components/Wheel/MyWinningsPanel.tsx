import { useTranslation } from "react-i18next";
import { useWallet } from "../../contexts/WalletContext";
import { useMyWinnings } from "../../hooks/useMyWinnings";
import { ulunaToDisplayNumber } from "../../lib/format";
import { isRevealed } from "../../lib/revealCache";
import { WHEEL_MANAGER_ADDRESS } from "../../lib/deployment";
import { RedeemBox } from "./RedeemBox";

type MyWinningsPanelProps = {
  redemptionDenom: string;
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
export function MyWinningsPanel({
  redemptionDenom,
  unclaimedDeadlineDays,
  contractAddress,
  onRedeemed,
  currentRoundId,
}: MyWinningsPanelProps) {
  const { t } = useTranslation();
  const { state: walletState } = useWallet();
  const address = walletState.status === "connected" ? walletState.address : null;
  const winnings = useMyWinnings(address, contractAddress);

  if (!address || winnings.status !== "loaded") return null;

  const revealedWinnings = winnings.winnings.filter(
    (entry) =>
      entry.round_id !== currentRoundId &&
      isRevealed(contractAddress ?? WHEEL_MANAGER_ADDRESS, entry.round_id, address)
  );
  if (revealedWinnings.length === 0) return null;

  return (
    <section className="my-winnings-panel">
      <h2 className="my-winnings-title">{t("myWinnings.title")}</h2>
      {revealedWinnings.map((entry) => (
        <div key={entry.round_id} className="my-winnings-entry">
          <p className="my-winnings-round">
            {t("myWinnings.round", {
              roundId: entry.round_id,
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
    </section>
  );
}
