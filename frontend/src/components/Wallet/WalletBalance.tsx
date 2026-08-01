import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useWallet } from "../../contexts/WalletContext";
import { useBalance } from "../../hooks/useBalance";
import { ulunaToDisplayNumber } from "../../lib/format";
import { PRIZE_ASSET_CHOICES, PRIZE_ASSET_DENOMS, PRIZE_ASSET_LABELS } from "../../lib/cyolPrizeDenoms";

// "My Bag": the wallet's balance in the site's 3 real assets (LUNC, USDC,
// USTC) - a dropdown rather than one number because creators can also hold
// LUNC (it's not USTC-exclusive). On this testnet usdc/lunc both resolve to
// the same "uluna" denom (see cyolPrizeDenoms.ts) - a real, testnet-only
// collision - so those two rows will show identical amounts until mainnet
// gives USDC its own IBC denom; ustc ("uusd") is already genuinely separate.
export function WalletBalance() {
  const { t } = useTranslation();
  const { state: walletState } = useWallet();
  const address = walletState.status === "connected" ? walletState.address : null;
  const [isOpen, setIsOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const lunc = useBalance(address, PRIZE_ASSET_DENOMS.lunc);
  const usdc = useBalance(address, PRIZE_ASSET_DENOMS.usdc);
  const ustc = useBalance(address, PRIZE_ASSET_DENOMS.ustc);
  const balances = { lunc, usdc, ustc };

  useEffect(() => {
    if (!isOpen) return;
    function onClickOutside(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setIsOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setIsOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onClickOutside);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [isOpen]);

  if (!address) return null;

  return (
    <div className="bag-wrap" ref={wrapRef}>
      <button
        type="button"
        className="bag-toggle-btn"
        aria-haspopup="true"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((v) => !v)}
      >
        <img src="/wheel-pixel/coinbag-icon.png" alt="" className="bag-toggle-icon" />
        <span className="bag-toggle-label">
          {t("wallet.bagToggle")} {isOpen ? "▴" : "▾"}
        </span>
      </button>
      {isOpen && (
        <div className="bag-panel">
          {PRIZE_ASSET_CHOICES.map((choice) => {
            const balance = balances[choice];
            return (
              <div className="bag-row" key={choice}>
                <span className="bag-row-label">{PRIZE_ASSET_LABELS[choice]}</span>
                <span className="bag-row-amount">
                  {balance.status === "loaded" ? ulunaToDisplayNumber(balance.amount).toFixed(2) : "…"}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
