import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { getAudioCtx, playWinChime } from "../../lib/audio";
import { burstConfetti } from "../../lib/confetti";
import { formatAmount } from "../../lib/cyolFormat";
import { isCyolRevealed, markCyolRevealed } from "../../lib/revealCache";

type AirdropShare = { share: string; claimed: boolean };

type Props = {
  // Keys the "already watched this reveal" check (see lib/revealCache) -
  // together with walletAddress, since this chest (unlike CyolRevealWheel)
  // is wallet-gated: one wallet opening it must never mark it "revealed"
  // for a different wallet visiting the same raffle.
  contractAddress: string;
  // null when no wallet is connected. Also doubles as the "is connected"
  // check (connected === walletAddress !== null) - no separate boolean, so
  // the two can never disagree.
  walletAddress: string | null;
  // null when no wallet is connected yet, or when connected but this wallet
  // never bought a ticket here (share stays "0") - both cases block opening,
  // see isParticipant below.
  myAirdropShare: AirdropShare | null;
  prizeCurrency: string;
  // Rendered once opened - the caller's existing personal claim/reclaim
  // markup, now gated behind the open-the-chest moment instead of
  // appearing the instant the raffle is drawn.
  children: ReactNode;
};

// Airdrop has no winner to spin a wheel for (the prize splits equally among
// everyone who bought a ticket) - its reveal moment is a chest opening to
// the connected wallet's own split instead, per the 2026-07-20 design note.
// Unlike SingleWinner's wheel (a public spectacle anyone can watch), the
// number behind this chest is personal - only a wallet that actually took
// part gets to open it (2026-07-25, user's call): a spectator without a
// stake has nothing of their own to reveal here.
export function CyolRevealChest({ contractAddress, walletAddress, myAirdropShare, prizeCurrency, children }: Props) {
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

  const isParticipant = myAirdropShare !== null && myAirdropShare.share !== "0";
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
        {opened && myAirdropShare && (
          <div className="cyol-chest-sign">
            <span className="cyol-chest-sign-amount">{formatAmount(myAirdropShare.share, prizeCurrency)}</span>
            <span className="cyol-chest-sign-label">{t("createYourOwnLuck.detail.perWalletLabel")}</span>
          </div>
        )}
      </div>

      {!connected && <p className="cyol-detail-hint">{t("createYourOwnLuck.detail.connectToCheckAirdrop")}</p>}
      {connected && !isParticipant && (
        <p className="cyol-form-error">{t("createYourOwnLuck.detail.notAnAirdropParticipant")}</p>
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
