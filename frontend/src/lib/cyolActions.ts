import { MsgExecuteContract } from "@goblinhunt/cosmes/client";
import type { ConnectedWallet } from "@goblinhunt/cosmes/wallet";

// Same fixed memo every other action in this app broadcasts with - see
// roundActions.ts.
const MEMO = "REPEG CLUB";

async function broadcast(wallet: ConnectedWallet, msgs: MsgExecuteContract<object>[]) {
  const res = await wallet.broadcastTxSync({ msgs, memo: MEMO });
  if (res.txResponse.code !== 0) {
    throw new Error(res.txResponse.rawLog || "Transaction failed.");
  }
  return res;
}

function execute(
  wallet: ConnectedWallet,
  contractAddress: string,
  msg: object,
  funds: { denom: string; amount: string }[] = []
) {
  return broadcast(wallet, [
    new MsgExecuteContract({ sender: wallet.address, contract: contractAddress, msg, funds }),
  ]);
}

// Native-prize raffles only. If the prize denom is the same as the USDC fee
// denom, the contract requires the fee to already be settled via a separate
// payServiceFee call first (can't tell prize and fee apart in a single
// attached coin of the same denom) - the caller is responsible for calling
// payServiceFee first in that case, this only sends the prize coin then.
export function depositPrize(
  wallet: ConnectedWallet,
  contractAddress: string,
  prizeDenom: string,
  prizeAmount: string,
  usdcDenom: string,
  feeAmountUsdc: string,
  feeAlreadyPaid: boolean
) {
  const funds =
    feeAlreadyPaid || prizeDenom === usdcDenom
      ? [{ denom: prizeDenom, amount: prizeAmount }]
      : [
          { denom: prizeDenom, amount: prizeAmount },
          { denom: usdcDenom, amount: feeAmountUsdc },
        ].sort((a, b) => a.denom.localeCompare(b.denom));
  return execute(wallet, contractAddress, { deposit_prize: {} }, funds);
}

// Only needed ahead of depositPrize when the prize denom is the USDC fee
// denom itself - see depositPrize above.
export function payServiceFee(
  wallet: ConnectedWallet,
  contractAddress: string,
  usdcDenom: string,
  feeAmountUsdc: string
) {
  return execute(wallet, contractAddress, { pay_service_fee: {} }, [
    { denom: usdcDenom, amount: feeAmountUsdc },
  ]);
}

export function buyTicket(
  wallet: ConnectedWallet,
  contractAddress: string,
  ticketDenom: string,
  ticketPriceAmount: string
) {
  return execute(wallet, contractAddress, { buy_ticket: {} }, [
    { denom: ticketDenom, amount: ticketPriceAmount },
  ]);
}

// Buys `quantity` tickets in a single signature: the contract's BuyTicket
// only ever registers one ticket per call (no quantity field), but a single
// broadcast transaction can carry any number of messages, each executed in
// order against the state the previous one left - Keplr signs the whole
// batch once instead of once per ticket. Atomic like any other transaction:
// if a later ticket in the batch would fail (e.g. it would exceed the
// per-wallet cap, or the raffle sells out partway through), the entire
// batch reverts rather than buying a partial amount - the caller is
// expected to keep `quantity` within the wallet's own remaining cap to
// avoid that (see maxTicketsPerWallet in the raffle detail page).
export function buyTickets(
  wallet: ConnectedWallet,
  contractAddress: string,
  ticketDenom: string,
  ticketPriceAmount: string,
  quantity: number
) {
  const msgs = Array.from(
    { length: quantity },
    () =>
      new MsgExecuteContract({
        sender: wallet.address,
        contract: contractAddress,
        msg: { buy_ticket: {} },
        funds: [{ denom: ticketDenom, amount: ticketPriceAmount }],
      })
  );
  return broadcast(wallet, msgs);
}

// Self-service refund for the caller's own tickets, only while the raffle
// hasn't reached min_players yet - the contract rejects clearly
// (NoTicketsToWithdraw) if the caller never bought any, so this is safe to
// expose to any connected wallet without knowing its ticket count upfront.
export function withdrawTicket(wallet: ConnectedWallet, contractAddress: string) {
  return execute(wallet, contractAddress, { withdraw_ticket: {} });
}

export function closeRound(wallet: ConnectedWallet, contractAddress: string) {
  return execute(wallet, contractAddress, { close_round: {} });
}

export function drawWinner(wallet: ConnectedWallet, contractAddress: string) {
  return execute(wallet, contractAddress, { draw_winner: {} });
}

export function claimAirdropShare(wallet: ConnectedWallet, contractAddress: string) {
  return execute(wallet, contractAddress, { claim_airdrop_share: {} });
}

export function reclaimUnclaimed(wallet: ConnectedWallet, contractAddress: string) {
  return execute(wallet, contractAddress, { reclaim_unclaimed: {} });
}

export function cancelRaffle(wallet: ConnectedWallet, contractAddress: string) {
  return execute(wallet, contractAddress, { cancel_raffle: {} });
}

// Permissionless safety net if the raffle never reached min_players within
// max_raffle_age_seconds.
export function expireRaffle(wallet: ConnectedWallet, contractAddress: string) {
  return execute(wallet, contractAddress, { expire_raffle: {} });
}
