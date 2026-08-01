import { useTranslation } from "react-i18next";
import type { Entrant } from "../../lib/wheelData";

type EntrantsPanelProps = {
  entrants: Entrant[];
};

export function EntrantsPanel({ entrants }: EntrantsPanelProps) {
  const { t } = useTranslation();
  const totalTickets = entrants.reduce((s, e) => s + e.tickets, 0);
  return (
    <div className="panel-border pixel-stepped-corners">
    <div className="panel-highlight pixel-stepped-corners">
    <div className="panel pixel-stepped-corners">
      <p className="panel-title">{t("entrants.title")}</p>
      <div>
        {entrants.map((a) => (
          <div className="ticket-outline pixel-stepped-corners-sm" key={a.name}>
            <div className="ticket pixel-stepped-corners-sm">
              <span className="swatch" style={{ background: a.color }} />
              <span className="entrant-name">{a.name}</span>
              <span className="entrant-meta">
                {t("entrants.ticket", { count: a.tickets })}
                <br />
                <span className="entrant-pct">
                  {totalTickets > 0 ? Math.round((a.tickets / totalTickets) * 100) : 0}%
                </span>
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
    </div>
    </div>
  );
}
