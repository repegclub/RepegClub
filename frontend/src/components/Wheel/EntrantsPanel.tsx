import { arcs, totalTickets } from "../../lib/wheelData";

export function EntrantsPanel() {
  return (
    <div className="panel">
      <p className="panel-title">Participantes</p>
      <div>
        {arcs.map((a) => (
          <div className="ticket" key={a.name}>
            <span className="swatch" style={{ background: a.color }} />
            <span className="entrant-name">{a.name}</span>
            <span className="entrant-meta">
              {a.tickets} ticket{a.tickets > 1 ? "s" : ""}
              <br />
              <span className="entrant-pct">
                {Math.round((a.tickets / totalTickets) * 100)}%
              </span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
