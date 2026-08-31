import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

// Lives in the sticky wallet-bar now (not its own row below the hero) so
// it's always reachable while scrolling, same as Connect Keplr/History/My
// Bag. A dropdown at every width, not just narrow - with only 3 games in it
// today there'd be room for separate chips on wide screens, but that means
// two different layouts to maintain for no real benefit, and it already has
// to be a dropdown on narrow (nothing else fits next to the wallet
// controls, which themselves expand once connected). Add an entry here when
// a new minigame gets its own page. Raffles (Create Your Own Luck's play
// side) belongs here, same as any other game - the separate "Creators" link
// below is for the OTHER audience of that same product (people running a
// raffle, or using any other creator tool), not a second entry for the same
// one.
const GAMES: { path: string; labelKey: string; icon?: string }[] = [
  { path: "/", labelKey: "gameSwitcher.wheelOfRepeg", icon: "/wheel-pixel/wheel-emoji.png" },
  { path: "/weekly-round", labelKey: "gameSwitcher.weeklyRound", icon: "/wheel-pixel/crown-emoji.png" },
  { path: "/create-your-own-luck", labelKey: "gameSwitcher.raffles", icon: "/wheel-pixel/clover-emoji.png" },
  // Same page as Raffles above, not a separate one - the `view=airdrops`
  // query param just tells CreateYourOwnLuckPage to land with the Airdrops
  // section open and Raffles collapsed, instead of the default (both open).
  {
    path: "/create-your-own-luck?view=airdrops",
    labelKey: "gameSwitcher.airdrops",
    icon: "/wheel-pixel/airdrop-emoji.png",
  },
];

export function GameNav({ current }: { current: string }) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

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

  return (
    <nav className="game-nav">
      <img src="/brand/isotipo-pixel-art.png" alt="Repeg Club" className="game-nav-logo" />
      <div className="game-nav-wrap" ref={wrapRef}>
        <button
          type="button"
          className="game-nav-toggle-btn"
          aria-haspopup="true"
          aria-expanded={isOpen}
          onClick={() => setIsOpen((v) => !v)}
        >
          {t("gameSwitcher.gamesToggle")}{" "}
          <span className="game-nav-toggle-arrow">{isOpen ? "▴" : "▾"}</span>
        </button>
        {isOpen && (
          <div className="game-nav-panel">
            {GAMES.map((game) => (
              <Link
                key={game.path}
                to={game.path}
                className={`game-nav-item${game.path === current ? " active" : ""}`}
                onClick={() => setIsOpen(false)}
              >
                {game.icon && <img src={game.icon} alt="" className="game-nav-item-icon" />}
                {t(game.labelKey)}
              </Link>
            ))}
          </div>
        )}
      </div>
      <Link
        to="/creators"
        className={`game-nav-creators${current === "/creators" ? " active" : ""}`}
      >
        <img src="/wheel-pixel/creators-icon.png" alt="" className="game-nav-creators-icon" />
        {t("gameSwitcher.creators")}
      </Link>
      {/* Not shown on /onramp itself - unlike Games/Create, there's nowhere
          left for it to navigate to from there. */}
      {current !== "/onramp" && (
        <Link to="/onramp" className="game-nav-onramp">
          <img src="/wheel-pixel/onramp-icon.png" alt="" className="game-nav-onramp-icon" />
          {t("gameSwitcher.onramp")}
        </Link>
      )}
    </nav>
  );
}
