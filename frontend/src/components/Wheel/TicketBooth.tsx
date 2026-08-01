import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ConnectedWallet } from "@goblinhunt/cosmes/wallet";
import { useWallet } from "../../contexts/WalletContext";
import { buyTicket } from "../../lib/roundActions";
import { HostGuide } from "./HostGuide";

type TicketBoothProps = {
  priceDisplay: string;
  ticketDenom?: string;
  ticketPriceAmount?: string;
  contractAddress?: string;
  // null = round not open / not loaded yet, don't show anything. See
  // lib/ticketAvailability.ts for why this is personalized per viewer
  // rather than a flat countdown.
  availableTickets?: number | null;
  ticketCap?: number;
  onPurchased?: () => void;
  // Defaults to Wheel Manager's buyTicket(). Weekly Round passes
  // buyWeeklyTicket instead - everything else here (validation, error
  // parsing, button state) is identical between the two.
  buyAction?: (
    wallet: ConnectedWallet,
    ticketDenom: string,
    ticketPriceAmount: string,
    contractAddress?: string
  ) => ReturnType<typeof buyTicket>;
};

export function TicketBooth({
  priceDisplay,
  ticketDenom,
  ticketPriceAmount,
  contractAddress,
  availableTickets,
  ticketCap,
  onPurchased,
  buyAction = buyTicket,
}: TicketBoothProps) {
  const { t } = useTranslation();
  const { state: walletState } = useWallet();
  const [buying, setBuying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Guarded, not trusted blindly - returnObjects falls back to the raw key
  // string (not an array) if ticketBooth.hostHype is ever missing from a
  // locale, and an empty array would otherwise make `% HYPE_LINES.length`
  // divide by zero below.
  const hostHype = t("ticketBooth.hostHype", { returnObjects: true });
  const HYPE_LINES = Array.isArray(hostHype) ? (hostHype as string[]) : [];
  const [hypeIndex, setHypeIndex] = useState(0);
  useEffect(() => {
    if (HYPE_LINES.length === 0) return;
    const id = setInterval(() => setHypeIndex((i) => (i + 1) % HYPE_LINES.length), 8000);
    return () => clearInterval(id);
  }, [HYPE_LINES.length]);

  const ready = walletState.status === "connected" && ticketDenom && ticketPriceAmount;

  async function handleBuy() {
    if (walletState.status !== "connected" || !ticketDenom || !ticketPriceAmount) return;
    setBuying(true);
    setError(null);
    try {
      await buyAction(walletState.wallet, ticketDenom, ticketPriceAmount, contractAddress);
      onPurchased?.();
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      // Matches contracts/wheel-manager/src/error.rs and
      // contracts/weekly-round/src/error.rs's actual Display text for these
      // ContractError variants (not the Rust variant names, which never
      // appear in the raw_log) - substrings common to both ("Round .../Week
      // ..." differ only in that one word) rather than the full sentence, so
      // this one component covers both games' error text.
      const capMatch = message.match(/maximum of (\d+) tickets/);
      if (message.includes("expired without reaching the minimum")) {
        setError(t("ticketBooth.roundExpiredHint"));
      } else if (message.includes("is not open")) {
        setError(t("ticketBooth.roundNotOpenHint"));
      } else if (capMatch) {
        setError(t("ticketBooth.ticketCapHint", { max: capMatch[1] }));
      } else {
        setError(message || t("ticketBooth.buyFailed"));
      }
    } finally {
      setBuying(false);
    }
  }

  return (
    <div className="ticket-booth-border pixel-stepped-corners">
    <div className="ticket-booth-highlight pixel-stepped-corners">
    <div className="ticket-booth pixel-stepped-corners">
      <div className="booth-art-wrap">
        <img src="/wheel-pixel/ticket-booth.png" alt="" className="booth-art" />
        <div className="booth-host-bubble">
          {HYPE_LINES[hypeIndex] && <HostGuide message={HYPE_LINES[hypeIndex]} bubbleType="rectangulo" />}
        </div>
      </div>
      <div className="booth-details">
        <div className="booth-info">
          <div>
            <p className="booth-label">{t("ticketBooth.label")}</p>
            <p className="booth-price">{priceDisplay}</p>
            {availableTickets !== null && availableTickets !== undefined && (
              <p className={`booth-available${availableTickets === 1 ? " booth-available-urgent" : ""}`}>
                {availableTickets === 1
                  ? t("ticketBooth.availableLast")
                  : t("ticketBooth.available", { count: availableTickets })}
              </p>
            )}
            {ticketCap !== undefined && (
              <p className="booth-cap-note">{t("ticketBooth.maxPerWallet", { max: ticketCap })}</p>
            )}
            {error && <p className="booth-error">{error}</p>}
          </div>
        </div>
        <button
          className="booth-buy"
          onClick={handleBuy}
          disabled={!ready || buying}
          title={walletState.status !== "connected" ? t("ticketBooth.connectFirst") : undefined}
        >
          {buying ? t("ticketBooth.buying") : t("ticketBooth.buy")}
        </button>
      </div>
    </div>
    </div>
    </div>
  );
}
