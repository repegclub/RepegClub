import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

// Same slot, same look on every game page - lets a player jump to the other
// game without hunting for it in mismatched spots (previously: one link
// buried in the wallet utility bar, the other a differently-styled banner
// elsewhere, so neither read as "the same action"). Add an entry here when
// a new game gets its own page (next: Create Your Own Luck).
const GAMES: { path: string; labelKey: string }[] = [
  { path: "/", labelKey: "gameSwitcher.wheelOfRepeg" },
  { path: "/weekly-round", labelKey: "gameSwitcher.weeklyRound" },
];

export function GameSwitcher({ current }: { current: string }) {
  const { t } = useTranslation();
  return (
    <nav className="game-switcher">
      {GAMES.map((game) =>
        game.path === current ? (
          <span key={game.path} className="game-switcher-chip active">
            {t(game.labelKey)}
          </span>
        ) : (
          <Link key={game.path} to={game.path} className="game-switcher-chip">
            {t(game.labelKey)}
          </Link>
        )
      )}
    </nav>
  );
}
