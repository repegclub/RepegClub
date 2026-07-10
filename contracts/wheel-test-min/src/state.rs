use cosmwasm_std::Addr;
use cw_storage_plus::Item;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, JsonSchema)]
pub struct State {
    pub admin: Addr,
    pub ticket_denom: String,
    pub pool: u128,
    pub winner: Option<Addr>,
    pub redeemed: bool,
}

pub const STATE: Item<State> = Item::new("state");
