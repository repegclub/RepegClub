import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import type { ConnectedWallet } from "@goblinhunt/cosmes/wallet";
import { useWallet } from "../../contexts/WalletContext";
import { buyTickets } from "../../lib/roundActions";
import { HostGuide } from "./HostGuide";

type TicketBoothProps = {
  priceDisplay: string;
  ticketDenom?: string;
  ticketPriceAmount?: string;
  contractAddress?: string;
  // null = round not open / not loaded yet, don't show anything. See
  // lib/ticketAvailability.ts for why this is personalized per viewer
  // rather than a flat countdown - also doubles as the quantity stepper's
  // own upper bound, since it already accounts for this wallet's own
  // remaining per-wallet cap AND the round's own remaining capacity.
  availableTickets?: number | null;
  ticketCap?: number;
  // The round's fixed sellable ceiling (computeAvailableTickets(<no
  // entrants>, maxPlayers, null) - see ticketAvailability.ts), shown next
  // to availableTickets (which counts down as the round fills) for
  // symmetry: one number that shrinks, one that doesn't, both in the same
  // "🎟️ ..." format - requested live to add context availableTickets alone
  // doesn't give.
  maxTicketsPerRound?: number;
  onPurchased?: () => void;
  // Defaults to Wheel Manager's buyTickets(). Weekly Round passes
  // buyWeeklyTickets instead - everything else here (validation, error
  // parsing, button state) is identical between the two. Takes a quantity
  // now instead of always buying exactly one - see buyTickets/
  // buyWeeklyTickets in roundActions.ts for how a multi-ticket purchase
  // batches into one signed transaction.
  buyAction?: (
    wallet: ConnectedWallet,
    ticketDenom: string,
    ticketPriceAmount: string,
    quantity: number,
    contractAddress?: string
  ) => ReturnType<typeof buyTickets>;
};

export function TicketBooth({
  priceDisplay,
  ticketDenom,
  ticketPriceAmount,
  contractAddress,
  availableTickets,
  ticketCap,
  maxTicketsPerRound,
  onPurchased,
  buyAction = buyTickets,
}: TicketBoothProps) {
  const { t } = useTranslation();
  const { state: walletState } = useWallet();
  const [buying, setBuying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // How many tickets THIS purchase will buy - defaults to 1, capped to
  // availableTickets (already personalized per wallet, see the prop's own
  // comment above). Clamped reactively, not just on input: availableTickets
  // can shrink out from under an already-chosen quantity (someone else buys
  // in between renders), and a stale too-high quantity would otherwise sit
  // there until the batched tx failed instead of being caught client-side.
  const [quantity, setQuantity] = useState(1);
  // availableTickets === 0 is a real, distinct state (round/week already at
  // capacity, or this wallet already at its per-wallet cap) - Math.max(1, 0)
  // would otherwise silently coerce it to the same "1" fallback used for
  // null/undefined ("not loaded yet"), leaving Buy enabled for a purchase
  // the contract will reject (CodeRabbit finding, confirmed against
  // ticketAvailability.ts's own computeAvailableTickets, which does return
  // exactly 0 in the real "round already full" case).
  const noneAvailable = availableTickets === 0;
  const maxBuyable = Math.max(1, availableTickets ?? 1);
  useEffect(() => {
    setQuantity((q) => Math.min(Math.max(1, q), maxBuyable));
  }, [maxBuyable]);

  // Guarded, not trusted blindly - returnObjects falls back to the raw key
  // string (not an array) if ticketBooth.hostHype is ever missing from a
  // locale, and an empty array would otherwise make `% HYPE_LINES.length`
  // divide by zero below. Elements are filtered too, not just the array
  // shape - a stray non-string/empty entry would still reach HostGuide's
  // message.split("\n") otherwise.
  const hostHype = t("ticketBooth.hostHype", { returnObjects: true });
  const HYPE_LINES = Array.isArray(hostHype)
    ? hostHype.filter((line): line is string => typeof line === "string" && line.trim().length > 0)
    : [];
  const [hypeIndex, setHypeIndex] = useState(0);
  useEffect(() => {
    if (HYPE_LINES.length === 0) return;
    const id = setInterval(() => setHypeIndex((i) => (i + 1) % HYPE_LINES.length), 8000);
    return () => clearInterval(id);
  }, [HYPE_LINES.length]);

  const ready = walletState.status === "connected" && ticketDenom && ticketPriceAmount && !noneAvailable;

  async function handleBuy() {
    if (walletState.status !== "connected" || !ticketDenom || !ticketPriceAmount) return;
    setBuying(true);
    setError(null);
    try {
      await buyAction(walletState.wallet, ticketDenom, ticketPriceAmount, quantity, contractAddress);
      setQuantity(1);
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
      {/* Split out from .booth-details (which used to wrap this + the button/
          stepper together) so mobile can grid them into 2 separate areas -
          price/info top-right next to the vendor, button/stepper their own
          full-width row below - without that empty gap under a shorter
          vendor image (see .ticket-booth's grid-template-areas below).
          Desktop/"modo estrecho" render identically either way: flex
          layout stacks direct DOM children in order regardless of this
          extra nesting level. */}
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
          {maxTicketsPerRound !== undefined && (
            <p className="booth-cap-note">{t("ticketBooth.maxPerRound", { max: maxTicketsPerRound })}</p>
          )}
          {error && <p className="booth-error">{error}</p>}
          <Link to="/onramp" className="booth-onramp-cta">
            {t("ticketBooth.onrampCta")}
          </Link>
        </div>
      </div>
      <div className="booth-details">
        <button
          className="booth-buy"
          onClick={handleBuy}
          disabled={!ready || buying}
          title={walletState.status !== "connected" ? t("ticketBooth.connectFirst") : undefined}
        >
          {buying
            ? t("ticketBooth.buying")
            : quantity > 1
              ? t("ticketBooth.buyTickets", { count: quantity })
              : t("ticketBooth.buy")}
        </button>
        {/* Hidden entirely below 2 (nothing to step between), same as CYOL's
            own quantity selector - a stepper that can only ever show "1"
            isn't useful, just clutter. +/- instead of a raw number input:
            this whole card is otherwise button-driven, not text-input-
            driven, and a stepper can't land on an invalid value by
            mistyping. */}
        {maxBuyable > 1 && (
          <div className="booth-quantity-stepper">
            <button
              type="button"
              className="booth-quantity-btn"
              onClick={() => setQuantity((q) => Math.max(1, q - 1))}
              disabled={quantity <= 1 || buying}
              aria-label={t("ticketBooth.quantityDecrease")}
            >
              −
            </button>
            <span className="booth-quantity-value">{quantity}</span>
            <button
              type="button"
              className="booth-quantity-btn"
              onClick={() => setQuantity((q) => Math.min(maxBuyable, q + 1))}
              disabled={quantity >= maxBuyable || buying}
              aria-label={t("ticketBooth.quantityIncrease")}
            >
              +
            </button>
          </div>
        )}
      </div>
    </div>
    </div>
    </div>
  );
}
