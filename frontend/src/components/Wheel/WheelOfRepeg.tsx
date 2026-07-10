import "../../styles/wheel.css";
import { SideBanners } from "./SideBanners";
import { MarqueeSign } from "./MarqueeSign";
import { TicketBooth } from "./TicketBooth";
import { WheelCard } from "./WheelCard";
import { EntrantsPanel } from "./EntrantsPanel";

export function WheelOfRepeg() {
  return (
    <>
      <SideBanners />

      <main>
        <MarqueeSign />

        <p className="lead">
          Maqueta de estilo y mecánica — colores y comportamiento a validar
          antes de conectar con la blockchain real. Los datos de esta
          pantalla son de prueba.
        </p>

        <TicketBooth />

        <div className="stage">
          <WheelCard />
          <EntrantsPanel />
        </div>

        <p className="disclaimer">
          El ganador ya está determinado on-chain antes de que la rueda
          empiece a girar (hash del bloque de cierre + lista de tickets). La
          animación solo hace visible ese resultado — no es la fuente del
          sorteo.
        </p>
      </main>
    </>
  );
}
