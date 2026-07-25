import { useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { getAudioCtx, playWinChime } from "../../lib/audio";
import { burstConfetti } from "../../lib/confetti";
import { formatAmount } from "../../lib/cyolFormat";
import { isCyolRevealed, markCyolRevealed } from "../../lib/revealCache";

type AirdropShare = { share: string; claimed: boolean };

type Props = {
  // Keys the "already watched this reveal" check (see lib/revealCache),
  // same idea and same storage as CyolRevealWheel - a contract address is
  // exclusively one raffle type, so the two never collide on the same key.
  contractAddress: string;
  connected: boolean;
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
export function CyolRevealChest({ contractAddress, connected, myAirdropShare, prizeCurrency, children }: Props) {
  const { t } = useTranslation();
  const [opened, setOpened] = useState(() => isCyolRevealed(contractAddress));
  const [opening, setOpening] = useState(false);
  const sceneRef = useRef<HTMLDivElement>(null);

  const isParticipant = myAirdropShare !== null && myAirdropShare.share !== "0";
  const canOpen = connected && isParticipant;

  function handleOpen() {
    if (opening || opened || !canOpen) return;
    getAudioCtx();
    setOpening(true);
    // Matches the CSS lid/glow/sign transition timings - the confetti/chime
    // land right as the sign finishes rising, not at the click itself.
    setTimeout(() => {
      setOpening(false);
      setOpened(true);
      if (sceneRef.current) burstConfetti(sceneRef.current);
      playWinChime();
      markCyolRevealed(contractAddress);
    }, 1750);
  }

  return (
    <div className="cyol-reveal-chest">
      <div
        ref={sceneRef}
        className={`cyol-chest-scene${opening || opened ? " cyol-chest-open" : ""}${
          connected && !isParticipant ? " cyol-chest-scene-locked" : ""
        }`}
      >
        <div className="cyol-chest-glow" />
        <div className="cyol-chest-coins">
          <span className="cyol-coin cyol-coin-1" />
          <span className="cyol-coin cyol-coin-2" />
          <span className="cyol-coin cyol-coin-3" />
        </div>
        <div className="cyol-chest-lid cyol-chest-wood">
          <div className="cyol-chest-lid-band" />
          <div className="cyol-chest-hasp-top" />
        </div>
        <div className="cyol-chest-body cyol-chest-wood">
          <div className="cyol-chest-band cyol-chest-band-top" />
          <div className="cyol-chest-band cyol-chest-band-bottom" />
          <div className="cyol-chest-lock" />
          <div className="cyol-chest-corner cyol-chest-corner-tl" />
          <div className="cyol-chest-corner cyol-chest-corner-tr" />
          <div className="cyol-chest-corner cyol-chest-corner-bl" />
          <div className="cyol-chest-corner cyol-chest-corner-br" />
        </div>
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
