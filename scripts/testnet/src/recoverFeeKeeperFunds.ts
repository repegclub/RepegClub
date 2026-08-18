// One-off recovery script, 2026-08-18. Not part of any ongoing
// infrastructure - delete after use.
//
// Context: FEE_KEEPER_COSMOS in frontend/src/lib/onrampConfig.ts used to
// list terra1h3898lq8fyspnlvpwknl9ffu8pttyjvxl7kran's OWN pubkey re-encoded
// with Noble/Cosmos Hub/Osmosis's bech32 prefixes, instead of genuinely
// deriving those chains' own coin-type-118 addresses for this seed. Terra
// Classic uses slip44 coin type 330 (see isValidTerraClassicAddress in
// onrampActions.ts), so this produced real, spendable, but "hidden"
// addresses - Keplr never shows them when switching to those chains with
// this account (it derives via 118 there instead), which is exactly the
// confusion this script exists to clean up. Onramp testing (2026-08-16)
// sent 5 real fee payments there before the mistake was caught. This
// script moves that small balance to the addresses Keplr actually shows
// for this same seed on each chain (coin type 118) - onrampConfig.ts has
// already been fixed to use those going forward.
//
// Usage: from scripts/testnet/, run
//   FEE_KEEPER_MNEMONIC="your 12-24 words" npx tsx src/recoverFeeKeeperFunds.ts
// Deliberately a real shell env var, not a line in .env - same rule
// .env.example already states for real-fund mnemonics: never write one to
// any file, even a gitignored one.

import { setChainSdkVersion, useChainSdkVersion } from "@goblinhunt/cosmes/protobufs";
import { MsgSend } from "@goblinhunt/cosmes/client";
import { MnemonicWallet } from "@goblinhunt/cosmes/wallet";

async function queryBalances(lcd: string, address: string): Promise<{ denom: string; amount: string }[]> {
  const res = await fetch(`${lcd}/cosmos/bank/v1beta1/balances/${address}`);
  const body = await res.json();
  return body.balances ?? [];
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name} - export it as a real shell env var before running this script.`);
  }
  return value;
}

const MNEMONIC = requireEnv("FEE_KEEPER_MNEMONIC");

type ChainSpec = {
  label: string;
  chainId: string;
  rpc: string;
  lcd: string;
  bech32Prefix: string;
  gasPrice: { amount: string; denom: string };
  sdkVersion?: "sdk47" | "sdk53";
  // The address this same seed derives at coin type 330 for this chain -
  // where the 5 test fees actually landed. Checked against onrampConfig.ts's
  // old (pre-fix) FEE_KEEPER_COSMOS entries.
  expectedOldAddress: string;
  // The address this same seed derives at coin type 118 - what Keplr shows
  // natively for this account on this chain, and onrampConfig.ts's new
  // FEE_KEEPER_COSMOS entry.
  newAddress: string;
  // Small fixed buffer left behind so the sweep tx itself always has gas -
  // same reserve pattern as onrampConfig.ts's DIRECT_ORIGIN_CHAINS.
  gasReserve: bigint;
};

const CHAINS: ChainSpec[] = [
  {
    label: "Noble",
    chainId: "noble-1",
    rpc: "https://rpc.cosmos.directory/noble",
    lcd: "https://rest.cosmos.directory/noble",
    bech32Prefix: "noble",
    gasPrice: { amount: "0.1", denom: "uusdc" },
    expectedOldAddress: "noble1h3898lq8fyspnlvpwknl9ffu8pttyjvx3eet8a",
    newAddress: "noble1gqamtvt98mptup8nhh7sx4uf59h2hfglt82gtr",
    gasReserve: 10_000n,
  },
  {
    label: "Cosmos Hub",
    chainId: "cosmoshub-4",
    rpc: "https://rpc.cosmos.directory/cosmoshub",
    lcd: "https://rest.cosmos.directory/cosmoshub",
    bech32Prefix: "cosmos",
    gasPrice: { amount: "0.025", denom: "uatom" },
    sdkVersion: "sdk53",
    expectedOldAddress: "cosmos1h3898lq8fyspnlvpwknl9ffu8pttyjvxe6vrln",
    newAddress: "cosmos1gqamtvt98mptup8nhh7sx4uf59h2hfglrylqnd",
    gasReserve: 10_000n,
  },
  {
    label: "Osmosis",
    chainId: "osmosis-1",
    rpc: "https://rpc.cosmos.directory/osmosis",
    lcd: "https://rest.cosmos.directory/osmosis",
    bech32Prefix: "osmo",
    gasPrice: { amount: "0.1", denom: "uosmo" },
    expectedOldAddress: "osmo1h3898lq8fyspnlvpwknl9ffu8pttyjvx3plnfp",
    newAddress: "osmo1gqamtvt98mptup8nhh7sx4uf59h2hfgltlvs9l",
    gasReserve: 20_000n,
  },
];

async function sweepChain(spec: ChainSpec) {
  if (spec.sdkVersion) {
    setChainSdkVersion(spec.chainId, spec.sdkVersion);
    useChainSdkVersion(spec.chainId);
  }

  const wallet = new MnemonicWallet({
    mnemonic: MNEMONIC,
    bech32Prefix: spec.bech32Prefix,
    chainId: spec.chainId,
    rpc: spec.rpc,
    gasPrice: spec.gasPrice,
    coinType: 330, // matches how these funds actually got here - see header
  });

  console.log(`\n--- ${spec.label} ---`);
  console.log(`Derived address: ${wallet.address}`);
  if (wallet.address !== spec.expectedOldAddress) {
    console.log(`Doesn't match the known old fee-keeper address (${spec.expectedOldAddress}) - skipping, nothing sent.`);
    return;
  }

  const balances = await queryBalances(spec.lcd, wallet.address);
  console.log(`Balances: ${JSON.stringify(balances)}`);

  for (const coin of balances) {
    const amount = BigInt(coin.amount);
    // Only apply the gas reserve to the chain's own gas denom - other
    // denoms (e.g. IBC-origin USDC sitting alongside native OSMO) can be
    // swept in full, nothing reserved out of them.
    const reserve = coin.denom === spec.gasPrice.denom ? spec.gasReserve : 0n;
    const sendAmount = amount > reserve ? amount - reserve : 0n;
    if (sendAmount <= 0n) {
      console.log(`  ${coin.denom}: ${amount} - too small to sweep after reserve, skipping.`);
      continue;
    }
    console.log(`  Sending ${sendAmount} ${coin.denom} to ${spec.newAddress}...`);
    const res = await wallet.broadcastTxSync({
      msgs: [
        new MsgSend({
          fromAddress: wallet.address,
          toAddress: spec.newAddress,
          amount: [{ denom: coin.denom, amount: sendAmount.toString() }],
        }),
      ],
      memo: "REPEG CLUB fee-keeper recovery",
    });
    console.log(`  code=${res.txResponse.code} hash=${res.txResponse.txhash}`);
  }
}

for (const spec of CHAINS) {
  await sweepChain(spec);
}
