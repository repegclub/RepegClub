use cosmwasm_schema::{cw_serde, QueryResponses};
use cosmwasm_std::Addr;

#[cw_serde]
pub struct InstantiateMsg {
    pub ticket_denom: String,
}

#[cw_serde]
pub enum ExecuteMsg {
    BuyTicket {},
    SetWinner { winner: String },
    Redeem {},
}

#[cw_serde]
#[derive(QueryResponses)]
pub enum QueryMsg {
    #[returns(StateResponse)]
    State {},
}

#[cw_serde]
pub struct StateResponse {
    pub admin: Addr,
    pub ticket_denom: String,
    pub pool: u128,
    pub winner: Option<Addr>,
    pub redeemed: bool,
}
