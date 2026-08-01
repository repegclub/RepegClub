import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

// Lives in the sticky wallet-bar now (not its own row below the hero) so
// it's always reachable while scrolling, same as Connect Keplr/History/My
// Bag. A dropdown at every width, not just narrow - with only 2 games in it
// today there'd be room for separate chips on wide screens, but that means
// two different layouts to maintain for no real benefit, and it already has
// to be a dropdown on narrow (nothing else fits next to the wallet
// controls, which themselves expand once connected). Add an entry here when
// a new minigame gets its own page. Create Your Own Luck is a separate
// "Creators" link, not part of this dropdown - different audience (people
// running a raffle, not playing one).
const GAMES: { path: string; labelKey: string; icon?: string }[] = [
  { path: "/", labelKey: "gameSwitcher.wheelOfRepeg", icon: "/wheel-pixel/wheel-emoji.png" },
  { path: "/weekly-round", labelKey: "gameSwitcher.weeklyRound", icon: "/wheel-pixel/crown-emoji.png" },
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
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [isOpen]);

  return (
    <nav className="game-nav">
      <div className="game-nav-wrap" ref={wrapRef}>
        <button type="button" className="game-nav-toggle-btn" onClick={() => setIsOpen((v) => !v)}>
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
        to="/create-your-own-luck"
        className={`game-nav-creators${current === "/create-your-own-luck" ? " active" : ""}`}
      >
        <img src="/wheel-pixel/clover-emoji.png" alt="" className="game-nav-creators-icon" />
        {t("gameSwitcher.creators")}
      </Link>
    </nav>
  );
}
