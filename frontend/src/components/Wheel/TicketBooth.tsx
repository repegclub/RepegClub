export function TicketBooth() {
  return (
    <div className="ticket-booth">
      <div className="booth-awning" />
      <div className="booth-info">
        <span className="booth-icon">🎟️</span>
        <div>
          <p className="booth-label">Precio del ticket</p>
          <p className="booth-price">
            $4.00 <span className="booth-currency">USDC</span>
          </p>
        </div>
      </div>
      <button className="booth-buy">Comprar ticket</button>
    </div>
  );
}
