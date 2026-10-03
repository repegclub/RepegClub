import { bech32 } from "@goblinhunt/cosmes/codec";
import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  http,
  isAddressEqual,
  zeroAddress,
  type EIP1193Provider,
  type Hex,
  type PublicClient,
} from "viem";
import {
  EVM_CHAIN_PARAMS,
  HYPERLANE_TERRA_CLASSIC_WARP,
  TERRA_CLASSIC_HYPERLANE_DOMAIN,
  type EvmChainParams,
  type HyperlaneAsset,
} from "./onrampConfig";
import { TxOutcomeUnknownError } from "./onrampActions";

// ---------- Hyperlane return leg: BSC/Ethereum -> Terra Classic (2026-10-03) ----------
// The EVM token itself is the Hyperlane router (HypERC20 synthetic, package
// 11.0.1 on all 5 - checked live), so a transfer is a single
// transferRemote call on it: it burns the user's tokens (no approve needed)
// and dispatches the message, paying the relayer's interchain gas from
// msg.value. TERRA's route also charges Delfos' 0.2% (LinearFee) on top, in
// TERRA, inside that same call - quoteTransferRemote already includes it.

const HYP_ERC20_ABI = [
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "routers",
    stateMutability: "view",
    inputs: [{ name: "domain", type: "uint32" }],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "quoteTransferRemote",
    stateMutability: "view",
    inputs: [
      { name: "destination", type: "uint32" },
      { name: "recipient", type: "bytes32" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [
      {
        type: "tuple[]",
        components: [
          { name: "token", type: "address" },
          { name: "amount", type: "uint256" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "transferRemote",
    stateMutability: "payable",
    inputs: [
      { name: "destination", type: "uint32" },
      { name: "recipient", type: "bytes32" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "messageId", type: "bytes32" }],
  },
] as const;

function viemChain(params: EvmChainParams) {
  return defineChain({
    id: params.chainId,
    name: params.name,
    nativeCurrency: { name: params.nativeSymbol, symbol: params.nativeSymbol, decimals: 18 },
    rpcUrls: { default: { http: [params.rpc] } },
  });
}

const publicClients = new Map<number, PublicClient>();

// Reads always go through our own RPC for the chain (see EVM_CHAIN_PARAMS),
// never through the wallet's provider.
export function evmPublicClient(params: EvmChainParams): PublicClient {
  let client = publicClients.get(params.chainId);
  if (!client) {
    client = createPublicClient({ chain: viemChain(params), transport: http(params.rpc) }) as PublicClient;
    publicClients.set(params.chainId, client);
  }
  return client;
}

export function evmChainParamsFor(domain: number): EvmChainParams {
  const params = EVM_CHAIN_PARAMS[domain];
  if (!params) throw new Error(`No EVM chain configured for Hyperlane domain ${domain}.`);
  return params;
}

// The Terra Classic side's address as Hyperlane's 32-byte recipient: a
// 20-byte wallet address gets 12 zero bytes in front (same layout the test
// script used for the real 2026-10-02 return transfer, and the mirror of
// evmAddressToHyperlaneRecipient in onrampActions.ts); a 32-byte contract
// address is used as-is. Anything else is refused rather than guessed.
export function terraClassicAddressToBytes32(address: string): Hex {
  const decoded = bech32.decode(address as `${string}1${string}`);
  if (decoded.prefix !== "terra") throw new Error("Not a Terra Classic address.");
  const bytes = bech32.fromWords(decoded.words);
  if (bytes.length !== 20 && bytes.length !== 32) {
    throw new Error("Unexpected Terra Classic address length.");
  }
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `0x${hex.padStart(64, "0")}`;
}

// The route's Terra Classic end, derived from the same warp contract the
// send-out leg uses - never a second hand-typed copy.
function expectedTerraRouter(asset: HyperlaneAsset): Hex {
  const warp = HYPERLANE_TERRA_CLASSIC_WARP[asset];
  return terraClassicAddressToBytes32(warp.kind === "cw20" ? warp.warpContract : warp.contract);
}

export type EvmInboundQuote = {
  // Interchain gas, in the chain's native coin (wei) - sent as msg.value.
  nativeGas: bigint;
  // Everything taken from the token balance: the amount itself plus, for
  // TERRA, Delfos' 0.2% route fee.
  tokenTotal: bigint;
};

// Live quote straight from the token contract. The shape is checked rather
// than trusted: the first entry must be the native coin, and every other
// entry must be this same token (TERRA's fee is charged in TERRA) - an
// unexpected third token would mean a cost this form doesn't know how to
// show or check, so it refuses instead.
export async function quoteEvmInbound(
  params: EvmChainParams,
  token: Hex,
  recipient: Hex,
  amount: bigint
): Promise<EvmInboundQuote> {
  const quotes = await evmPublicClient(params).readContract({
    address: token,
    abi: HYP_ERC20_ABI,
    functionName: "quoteTransferRemote",
    args: [TERRA_CLASSIC_HYPERLANE_DOMAIN, recipient, amount],
  });
  if (quotes.length < 2 || !isAddressEqual(quotes[0].token, zeroAddress)) {
    throw new Error("Unexpected quote from the token contract.");
  }
  let tokenTotal = 0n;
  for (const q of quotes.slice(1)) {
    if (!isAddressEqual(q.token, token)) throw new Error("Unexpected quote from the token contract.");
    tokenTotal += q.amount;
  }
  if (tokenTotal < amount) throw new Error("Unexpected quote from the token contract.");
  return { nativeGas: quotes[0].amount, tokenTotal };
}

export async function readEvmBalances(
  params: EvmChainParams,
  token: Hex,
  owner: Hex
): Promise<{ token: bigint; native: bigint }> {
  const client = evmPublicClient(params);
  const [tokenBalance, native] = await Promise.all([
    client.readContract({ address: token, abi: HYP_ERC20_ABI, functionName: "balanceOf", args: [owner] }),
    client.getBalance({ address: owner }),
  ]);
  return { token: tokenBalance, native };
}

// How long to wait for the receipt before handing the user a tx hash to
// check instead of an answer. BSC confirms in seconds and Ethereum in ~12s,
// so 3 minutes only runs out under real congestion.
const RECEIPT_TIMEOUT_MS = 180_000;

// Sends `amount` of `asset` from the connected EVM wallet to `terraClassicAddress`.
// Every check that can be done before signing is redone here, right before
// the wallet prompt, from our own RPC rather than whatever the form showed:
// the route still points at the expected Terra Classic contract, a fresh
// quote, and both balances covering it (token: amount + route fee; native:
// interchain gas + this tx's own gas). msg.value is the exact fresh quote -
// paying less fails the tx in the contract (safe), and nothing is gained by
// paying more.
export async function sendEvmToTerraClassic(args: {
  provider: EIP1193Provider;
  account: Hex;
  params: EvmChainParams;
  asset: HyperlaneAsset;
  token: Hex;
  amount: bigint;
  terraClassicAddress: string;
}): Promise<{ txHash: Hex }> {
  const { provider, account, params, asset, token, amount, terraClassicAddress } = args;
  if (amount <= 0n) throw new Error("Amount must be greater than zero.");
  const recipient = terraClassicAddressToBytes32(terraClassicAddress);
  const client = evmPublicClient(params);

  const router = await client.readContract({
    address: token,
    abi: HYP_ERC20_ABI,
    functionName: "routers",
    args: [TERRA_CLASSIC_HYPERLANE_DOMAIN],
  });
  if (router.toLowerCase() !== expectedTerraRouter(asset).toLowerCase()) {
    throw new Error("This route doesn't point to the expected Terra Classic contract - nothing was sent.");
  }
  // The form's micro-unit math (displayToMicro) assumes 6 decimals, like
  // every token on this leg today (checked live on all 5) - refuse rather
  // than move a different amount than the user typed.
  const decimals = await client.readContract({ address: token, abi: HYP_ERC20_ABI, functionName: "decimals" });
  if (decimals !== 6) throw new Error(`Unexpected ${asset} decimals (${decimals}) - nothing was sent.`);

  const quote = await quoteEvmInbound(params, token, recipient, amount);
  const balances = await readEvmBalances(params, token, account);
  if (balances.token < quote.tokenTotal) throw new Error(`Not enough ${asset} for this amount plus fees.`);

  const txGas = await client.estimateContractGas({
    account,
    address: token,
    abi: HYP_ERC20_ABI,
    functionName: "transferRemote",
    args: [TERRA_CLASSIC_HYPERLANE_DOMAIN, recipient, amount],
    value: quote.nativeGas,
  });
  const gasPrice = await client.getGasPrice();
  if (balances.native < quote.nativeGas + txGas * gasPrice) {
    throw new Error(`Not enough ${params.nativeSymbol} to pay the gas for this transfer.`);
  }

  const chain = viemChain(params);
  const wallet = createWalletClient({ account, chain, transport: custom(provider) });
  await wallet.switchChain({ id: params.chainId });
  // switchChain resolving isn't proof - some wallets resolve without
  // switching. Checked against the wallet's own answer before signing.
  const walletChainId = await wallet.getChainId();
  if (walletChainId !== params.chainId) {
    throw new Error(`Switch your wallet to ${params.name} and try again.`);
  }

  // Anything thrown up to and including this call means nothing was sent
  // (rejected in the wallet, or refused before broadcast).
  const txHash = await wallet.writeContract({
    address: token,
    abi: HYP_ERC20_ABI,
    functionName: "transferRemote",
    args: [TERRA_CLASSIC_HYPERLANE_DOMAIN, recipient, amount],
    value: quote.nativeGas,
    chain,
  });

  // From here on the tx exists: failing to read its receipt is "unknown",
  // never a retryable error.
  let status: "success" | "reverted";
  try {
    const receipt = await client.waitForTransactionReceipt({ hash: txHash, timeout: RECEIPT_TIMEOUT_MS });
    status = receipt.status;
  } catch (err) {
    console.error(err);
    throw new TxOutcomeUnknownError(txHash);
  }
  if (status !== "success") {
    throw new Error(`The transaction failed on ${params.name} (nothing was bridged). Tx: ${txHash}`);
  }
  return { txHash };
}
