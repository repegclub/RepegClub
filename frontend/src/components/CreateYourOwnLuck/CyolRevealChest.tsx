import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { getAudioCtx, playWinChime } from "../../lib/audio";
import { burstConfetti } from "../../lib/confetti";
import { formatAmount } from "../../lib/cyolFormat";
import { isCyolRevealed, markCyolRevealed } from "../../lib/revealCache";

type AirdropShare = { share: string; claimed: boolean };

function truncateAddress(addr: string): string {
  return `${addr.slice(0, 10)}...${addr.slice(-4)}`;
}

type CommonProps = {
  // Keys the "already watched this reveal" check (see lib/revealCache) -
  // together with walletAddress, since this chest is wallet-gated: one
  // wallet opening it must never mark it "revealed" for a different wallet
  // visiting the same raffle.
  contractAddress: string;
  // null when no wallet is connected. Also doubles as the "is connected"
  // check (connected === walletAddress !== null) - no separate boolean, so
  // the two can never disagree.
  walletAddress: string | null;
  prizeCurrency: string;
  // Rendered once opened - the caller's existing personal claim/reclaim (or,
  // in winner mode, the full per-place winner breakdown) markup, now gated
  // behind the open-the-chest moment instead of appearing the instant the
  // raffle is drawn/revealed.
  children: ReactNode;
};

type AirdropProps = CommonProps & {
  mode: "airdrop";
  // null when no wallet is connected yet, or when connected but this wallet
  // never bought a ticket here (share stays "0") - both cases block opening,
  // see isParticipant below.
  myAirdropShare: AirdropShare | null;
};

type WinnerProps = CommonProps & {
  mode: "winner";
  // Whether the connected wallet bought at least one ticket here - the
  // winner-mode equivalent of an airdrop share, since there's no % to gate
  // opening on for Single Winner/Podium.
  hasTicket: boolean;
  // The raffle's top (first-place) winner and their prize - always shown in
  // the chest once opened, regardless of who's watching. The full per-place
  // breakdown for Podium lives in `children`, unaffected by this.
  winnerAddress: string;
  winnerPrize: string;
  // Whether the connected wallet itself is among the winners (any place),
  // not just the top one - drives the "You won!"/"You didn't win this time"
  // line independent of which place is shown above.
  isWinner: boolean;
};

type Props = AirdropProps | WinnerProps;

// Single Winner/Podium's reveal moment used to be a spinning wheel
// (CyolRevealWheel, retired 2026-09-01) built on the pre-pixel-art
// WheelCanvas prototype - it visually clashed with the rest of the site.
// Reusing this chest instead (decided 2026-08-31: "the chest is genial and
// works visually") also fits the scene better - CYOL's puesto artwork
// already draws a chest, no wheel exists anywhere in that art. Airdrop has
// no winner to reveal either way (the prize splits equally among everyone
// who bought a ticket) - its reveal shows the connected wallet's own split
// instead, per the 2026-07-20 design note. Both modes share the same
// gating pattern: only a wallet with a real stake in the outcome (a ticket)
// gets to open it (2026-07-25 for Airdrop, extended to winner mode
// 2026-08-31) - a spectator without a stake has nothing of their own to
// reveal here.
export function CyolRevealChest(props: Props) {
  const { contractAddress, walletAddress, prizeCurrency, children } = props;
  const { t } = useTranslation();
  const connected = walletAddress !== null;
  const [opened, setOpened] = useState(() => isCyolRevealed(contractAddress, walletAddress));
  const [opening, setOpening] = useState(false);
  const sceneRef = useRef<HTMLDivElement>(null);
  // Lets the open animation's timeout be cancelled if this unmounts
  // mid-sequence (navigating away, or the parent's key change on a wallet
  // switch) - otherwise it'd fire later against a gone component, playing a
  // sound/writing localStorage for a raffle the wallet isn't even looking
  // at anymore.
  const openTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (openTimeoutRef.current) clearTimeout(openTimeoutRef.current);
    };
  }, []);

  const isParticipant = props.mode === "airdrop" ? props.myAirdropShare !== null && props.myAirdropShare.share !== "0" : props.hasTicket;
  const canOpen = connected && isParticipant;

  function handleOpen() {
    if (opening || opened || !canOpen) return;
    getAudioCtx();
    setOpening(true);
    // Matches the CSS lid/glow/sign transition timings - the confetti/chime
    // land right as the sign finishes rising, not at the click itself.
    openTimeoutRef.current = setTimeout(() => {
      setOpening(false);
      setOpened(true);
      if (sceneRef.current) burstConfetti(sceneRef.current);
      playWinChime();
      markCyolRevealed(contractAddress, walletAddress);
    }, 1750);
  }

  return (
    <div className="cyol-reveal-chest">
      <div
        ref={sceneRef}
        className={`cyol-chest-scene${opened ? " cyol-chest-open" : ""}${
          connected && !isParticipant ? " cyol-chest-scene-locked" : ""
        }`}
      >
        <div className="cyol-chest-glow" />
        <div className="cyol-chest-coins">
          <span className="cyol-coin cyol-coin-1" />
          <span className="cyol-coin cyol-coin-2" />
          <span className="cyol-coin cyol-coin-3" />
        </div>
        {/* Static pixel-art chest (closed/open), swapped the instant
            `opened` flips - replaces the old CSS-drawn wood chest and its
            hinged-lid rotation, which clashed with the rest of the site's
            pixel-art look (direct request, 2026-08-20). The lid-opening
            motion is gone; the glow/coins/sign payoff below still fires at
            the same moment, so the reveal still lands as one beat instead
            of the chest looking "open" before the actual result appears. */}
        <img src="/wheel-pixel/cyol-chest-closed.png" alt="" className="cyol-chest-img cyol-chest-img-closed" />
        <img src="/wheel-pixel/cyol-chest-open.png" alt="" className="cyol-chest-img cyol-chest-img-open" />
        {opened && props.mode === "airdrop" && props.myAirdropShare && (
          <div className="cyol-chest-sign">
            <span className="cyol-chest-sign-amount">{formatAmount(props.myAirdropShare.share, prizeCurrency)}</span>
            <span className="cyol-chest-sign-label">{t("createYourOwnLuck.detail.perWalletLabel")}</span>
          </div>
        )}
        {opened && props.mode === "winner" && (
          <div className="cyol-chest-sign">
            <span className="cyol-chest-sign-amount">
              {t("createYourOwnLuck.detail.winnerLine", {
                winner: truncateAddress(props.winnerAddress),
                prize: formatAmount(props.winnerPrize, prizeCurrency),
              })}
            </span>
            <span className="cyol-chest-sign-label">
              {t(props.isWinner ? "createYourOwnLuck.detail.chestYouWon" : "createYourOwnLuck.detail.chestDidntWin")}
            </span>
          </div>
        )}
      </div>

      {!connected && (
        <p className="cyol-detail-hint">
          {t(props.mode === "airdrop" ? "createYourOwnLuck.detail.connectToCheckAirdrop" : "createYourOwnLuck.detail.connectToCheckWinner")}
        </p>
      )}
      {connected && !isParticipant && (
        <p className="cyol-form-error">
          {t(props.mode === "airdrop" ? "createYourOwnLuck.detail.notAnAirdropParticipant" : "createYourOwnLuck.detail.notATicketHolder")}
        </p>
      )}
      {canOpen && !opened && (
        <button type="button" className="spin-btn" onClick={handleOpen} disabled={opening}>
          {t(opening ? "createYourOwnLuck.detail.openingChest" : "createYourOwnLuck.detail.openChest")}
        </button>
      )}
      {opened && children}
    </div>
  );
}
