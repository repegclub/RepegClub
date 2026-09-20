// Browser tool for the real mainnet deploy of create-your-own-luck-factory /
// weekly-round / wheel-manager. Same messages and same defaults as
// deployCreateYourOwnLuckFactoryMainnet.ts / deployWeeklyRoundMainnet.ts /
// deployWheelManagerMainnet.ts (the tested node scripts) - the only real
// change is that signing goes through Keplr (KeplrController, same one the
// production frontend already uses to connect wallets) instead of a
// MnemonicWallet built from ADMIN_MNEMONIC/COMMIT_PUSHER_MNEMONIC. Built
// after a real incident (2026-07-13, see Obsidian): mnemonics exported via
// `export` in a terminal ended up recorded in plaintext in ~/.zsh_history.
// This page never asks for or touches a mnemonic - only Keplr's own
// in-extension approval popup, exactly like buying a ticket on the real site.
//
// Local-only tool: run `npm run mainnet-deploy-ui` and open the URL Vite
// prints. Not part of the deployed frontend.

import { Buffer } from "buffer";

import { fromBech32 } from "@cosmjs/encoding";
import { KeplrController, WalletType, type ConnectedWallet } from "@goblinhunt/cosmes/wallet";
import { MsgInstantiateContract, MsgStoreCode } from "./msgs";

// msgs.ts's toAmino() uses Node's Buffer, which isn't defined in a browser
// bundle by default - only exercised if Keplr signs via amino (Ledger
// hardware accounts; a normal software account signs via protobuf/direct
// instead, see KeplrController.connectExtension's isNanoLedger check). Shimmed
// so this page doesn't silently break for a Ledger-connected admin wallet.
(globalThis as { Buffer?: typeof Buffer }).Buffer ??= Buffer;

// Mirrors scripts/testnet/src/config.ts and configMainnet.ts - duplicated
// here (rather than imported) because those files do `import "dotenv/config"`,
// which touches Node's fs/path at import time and breaks when bundled for
// the browser. Keep these in sync with config.ts/configMainnet.ts by hand.
// Testnet is here so this tool can be validated end-to-end (a real deploy,
// zero real-money stakes) before ever pointing it at mainnet - same caution
// already applied to the treasury multisig UI.
type NetworkConfig = {
  chainId: string;
  rpc: string;
  gasPrice: { amount: string; denom: string };
  ticketDenom: string;
  redemptionDenom: string;
  treasuryAddress: string;
  adminFeeAddress: string;
};
const NETWORKS: Record<"testnet" | "mainnet", NetworkConfig> = {
  testnet: {
    chainId: "rebel-2",
    rpc: "https://rpc.terra-classic.hexxagon.dev",
    gasPrice: { amount: "28.325", denom: "uluna" },
    // uluna/uluna (the old testnet default in config.ts's deploy scripts)
    // now gets rejected - the round-11 audit fix (103a4f8, compiled into
    // today's artifacts) added `redemption_denom != ticket_denom` validation
    // at instantiate. Any 2 distinct denom strings satisfy it (it's a plain
    // inequality check, not a supply/liquidity check) - uusd picked as a
    // real Terra Classic denom rather than a nonsense placeholder, found
    // live 2026-09-10 testing this tool.
    ticketDenom: "uluna",
    redemptionDenom: "uusd",
    treasuryAddress: "terra1juzyema7r4gvrrvrkkznceyeyhfkdj6zvz20fd",
    adminFeeAddress: "terra15dv0f2rykyp6gyvuhawk8qgfd7ypm4lgkm4z39",
  },
  mainnet: {
    chainId: "columbus-5",
    rpc: "https://terra-classic-rpc.publicnode.com",
    gasPrice: { amount: "28.325", denom: "uluna" },
    ticketDenom: "ibc/0BB9D8513E8E8E9AE6A9D211D9136E6DA42288DDE6CFAA453A150A4566054DC5", // USDC via Noble
    redemptionDenom: "uusd", // USTC, native
    treasuryAddress: "terra1pmrw0x576skdqxel7aakph7nhjscuczn3kke0z",
    adminFeeAddress: "terra1h3898lq8fyspnlvpwknl9ffu8pttyjvxl7kran",
  },
};
function currentNetwork(): NetworkConfig {
  const value = el<HTMLSelectElement>("network").value as "testnet" | "mainnet";
  return NETWORKS[value];
}
// Same public WalletConnect project ID the production frontend uses
// (frontend/src/lib/walletConnectConfig.ts) - only exercised by the mobile/
// QR path, which this page never uses (extension-only below), but
// KeplrController's constructor wires up a WalletConnect client eagerly
// regardless of whether it's ever used.
const WC_PROJECT_ID = "f72d5273848eaf9e02cf03c1f74020f3";

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing #${id} in the page.`);
  return found as T;
}

function setStatus(id: string, message: string, isError = false) {
  const target = el<HTMLDivElement>(id);
  target.textContent = message;
  target.className = isError ? "status error" : "status";
}

async function readWasmFile(inputId: string): Promise<Uint8Array> {
  const input = el<HTMLInputElement>(inputId);
  const file = input.files?.[0];
  if (!file) throw new Error(`Pick a .wasm file for #${inputId} first.`);
  return new Uint8Array(await file.arrayBuffer());
}

async function connectAdmin(net: NetworkConfig): Promise<ConnectedWallet> {
  const controller = new KeplrController(WC_PROJECT_ID);
  if (!(await controller.isInstalled(WalletType.EXTENSION))) {
    throw new Error("Keplr not found - is the extension installed and unlocked?");
  }
  const wallets = await controller.connect(WalletType.EXTENSION, [
    { chainId: net.chainId, rpc: net.rpc, gasPrice: net.gasPrice, sdkVersion: "sdk53" },
  ]);
  const wallet = wallets.get(net.chainId);
  if (!wallet) throw new Error(`Keplr connected but returned no wallet for ${net.chainId}.`);
  return wallet;
}

async function storeCode(wallet: ConnectedWallet, wasmByteCode: Uint8Array, label: string) {
  const res = await wallet.broadcastTxSync({
    msgs: [new MsgStoreCode({ sender: wallet.address, wasmByteCode })],
  });
  if (res.txResponse.code !== 0) throw new Error(`${label} store failed: ${res.txResponse.rawLog}`);
  const codeIdAttr = res.txResponse.events
    .find((e) => e.type === "store_code")
    ?.attributes.find((a) => a.key === "code_id");
  if (!codeIdAttr) throw new Error(`code_id not found in ${label} store_code tx events`);
  return { codeId: BigInt(codeIdAttr.value), gasUsed: res.txResponse.gasUsed, txhash: res.txResponse.txhash };
}

async function instantiate<T>(wallet: ConnectedWallet, codeId: bigint, label: string, msg: T) {
  const res = await wallet.broadcastTxSync({
    msgs: [new MsgInstantiateContract<T>({ sender: wallet.address, codeId, label, msg, funds: [] })],
  });
  if (res.txResponse.code !== 0) throw new Error(`${label} instantiate failed: ${res.txResponse.rawLog}`);
  const addrAttr = res.txResponse.events
    .find((e) => e.type === "instantiate")
    ?.attributes.find((a) => a.key === "_contract_address");
  if (!addrAttr) throw new Error(`contract address not found in ${label} instantiate tx events`);
  return { contractAddress: addrAttr.value, gasUsed: res.txResponse.gasUsed, txhash: res.txResponse.txhash };
}

// A malformed address (typo, wrong chain's prefix) used to only surface at
// instantiate() - by then storeCode() already spent real gas (CodeRabbit
// finding, 2026-09-19 review, third round). Both testnet and mainnet use the
// "terra" Bech32 prefix, so this is safe to check for either network.
function requireValidTerraAddress(address: string, fieldLabel: string): void {
  let prefix: string;
  try {
    prefix = fromBech32(address).prefix;
  } catch {
    throw new Error(`${fieldLabel} "${address}" isn't a valid Bech32 address.`);
  }
  if (prefix !== "terra") {
    throw new Error(`${fieldLabel} "${address}" has prefix "${prefix}", expected "terra1...".`);
  }
}

// ---- 1. Create Your Own Luck (raffle code) + its factory ----

async function deployCyolFactory() {
  const label = el<HTMLInputElement>("cyolLabel").value.trim();
  const commitPusherAddress = el<HTMLInputElement>("cyolCommitPusher").value.trim();
  if (!label) throw new Error("Fill in a label.");
  if (!commitPusherAddress) throw new Error("Fill in the commit_pusher address.");
  requireValidTerraAddress(commitPusherAddress, "commit_pusher address");

  const raffleWasm = await readWasmFile("cyolRaffleWasm");
  const factoryWasm = await readWasmFile("cyolFactoryWasm");

  setStatus("cyolStatus", "Connecting Keplr...");
  const admin = await connectAdmin(currentNetwork());
  setStatus("cyolStatus", `Connected as ${admin.address}. Storing raffle code...`);

  const raffle = await storeCode(admin, raffleWasm, "create-your-own-luck");
  setStatus("cyolStatus", `Raffle code ID: ${raffle.codeId} (gasUsed ${raffle.gasUsed}). Storing factory code...`);

  const factory = await storeCode(admin, factoryWasm, "create-your-own-luck-factory");
  setStatus("cyolStatus", `Factory code ID: ${factory.codeId} (gasUsed ${factory.gasUsed}). Instantiating factory...`);

  const inst = await instantiate(admin, factory.codeId, `create-your-own-luck-factory-${label}`, {
    raffle_code_id: Number(raffle.codeId),
    commit_pusher: commitPusherAddress,
  });

  const result = {
    raffleCodeId: raffle.codeId.toString(),
    factoryCodeId: factory.codeId.toString(),
    contractAddress: inst.contractAddress,
  };
  el<HTMLTextAreaElement>("cyolOutput").value = JSON.stringify(result, null, 2);
  setStatus("cyolStatus", `Done. Factory address: ${inst.contractAddress} (gasUsed ${inst.gasUsed}).`);
}

// ---- 2. Weekly Round ----

async function deployWeeklyRound() {
  const label = el<HTMLInputElement>("weeklyLabel").value.trim();
  const commitPusherAddress = el<HTMLInputElement>("weeklyCommitPusher").value.trim();
  const maxPlayers = Number(el<HTMLInputElement>("weeklyMaxPlayers").value || "10");
  const minPlayers = Number(el<HTMLInputElement>("weeklyMinPlayers").value || "2");
  const roundDurationDays = Number(el<HTMLInputElement>("weeklyDuration").value || "7");
  if (!label) throw new Error("Fill in a label.");
  if (!commitPusherAddress) throw new Error("Fill in the commit_pusher address.");
  requireValidTerraAddress(commitPusherAddress, "commit_pusher address");
  // Same bounds as deployWeeklyRoundMainnet.ts (the CLI twin) - this
  // browser UI never had them (CodeRabbit finding, 2026-09-19 review,
  // fifth round; bounds verified against contracts/weekly-round/src/
  // contract.rs's real instantiate validation).
  if (!Number.isSafeInteger(minPlayers) || minPlayers < 2) {
    throw new Error(`minPlayers must be an integer >= 2, got "${minPlayers}".`);
  }
  if (!Number.isSafeInteger(maxPlayers) || maxPlayers < minPlayers || maxPlayers > 100) {
    throw new Error(`maxPlayers must be an integer between minPlayers (${minPlayers}) and 100, got "${maxPlayers}".`);
  }
  if (!Number.isSafeInteger(roundDurationDays) || roundDurationDays < 1 || roundDurationDays > 365) {
    throw new Error(`roundDurationDays must be an integer between 1 and 365, got "${roundDurationDays}".`);
  }

  const wasm = await readWasmFile("weeklyWasm");
  const net = currentNetwork();

  setStatus("weeklyStatus", "Connecting Keplr...");
  const admin = await connectAdmin(net);
  setStatus("weeklyStatus", `Connected as ${admin.address}. Storing code...`);

  const stored = await storeCode(admin, wasm, "weekly-round");
  setStatus("weeklyStatus", `Code ID: ${stored.codeId} (gasUsed ${stored.gasUsed}). Instantiating...`);

  const inst = await instantiate(admin, stored.codeId, `weekly-round-${label}`, {
    base_ticket_price: "10000000",
    price_increment_per_day: "1000000",
    ticket_denom: net.ticketDenom,
    redemption_denom: net.redemptionDenom,
    min_players: minPlayers,
    max_players: maxPlayers,
    round_duration_days: roundDurationDays,
    max_reveal_age_seconds: 3600,
    unclaimed_deadline_days: 90,
    treasury_address: net.treasuryAddress,
    admin_fee_address: net.adminFeeAddress,
    commit_pusher: commitPusherAddress,
  });

  const result = { codeId: stored.codeId.toString(), contractAddress: inst.contractAddress };
  el<HTMLTextAreaElement>("weeklyOutput").value = JSON.stringify(result, null, 2);
  el<HTMLInputElement>("wheelWeeklyAddress").value = inst.contractAddress;
  setStatus("weeklyStatus", `Done. Address: ${inst.contractAddress} (gasUsed ${inst.gasUsed}).`);
}

// ---- 3. Wheel Manager ----

async function deployWheelManager() {
  const label = el<HTMLInputElement>("wheelLabel").value.trim();
  const commitPusherAddress = el<HTMLInputElement>("wheelCommitPusher").value.trim();
  const weeklyRoundAddress = el<HTMLInputElement>("wheelWeeklyAddress").value.trim();
  const maxPlayers = Number(el<HTMLInputElement>("wheelMaxPlayers").value || "10");
  const minPlayers = Number(el<HTMLInputElement>("wheelMinPlayers").value || "2");
  const ticketPrice = el<HTMLInputElement>("wheelTicketPrice").value.trim() || "1000000";
  if (!label) throw new Error("Fill in a label.");
  if (!commitPusherAddress) throw new Error("Fill in the commit_pusher address.");
  if (!weeklyRoundAddress) throw new Error("Fill in Weekly Round's address (deploy step 2 first).");
  requireValidTerraAddress(commitPusherAddress, "commit_pusher address");
  requireValidTerraAddress(weeklyRoundAddress, "Weekly Round address");
  // Same bounds as deployWheelManagerMainnet.ts (the CLI twin) - this
  // browser UI never had them (CodeRabbit finding, 2026-09-19 review,
  // fifth round; bounds verified against contracts/wheel-manager/src/
  // contract.rs's real instantiate validation).
  if (!Number.isSafeInteger(minPlayers) || minPlayers < 2) {
    throw new Error(`minPlayers must be an integer >= 2, got "${minPlayers}".`);
  }
  if (!Number.isSafeInteger(maxPlayers) || maxPlayers < minPlayers || maxPlayers > 100) {
    throw new Error(`maxPlayers must be an integer between minPlayers (${minPlayers}) and 100, got "${maxPlayers}".`);
  }
  if (!/^[1-9]\d*$/.test(ticketPrice)) {
    throw new Error(`ticketPrice must be a positive integer string (micro-units), got "${ticketPrice}".`);
  }

  const wasm = await readWasmFile("wheelWasm");
  const net = currentNetwork();

  setStatus("wheelStatus", "Connecting Keplr...");
  const admin = await connectAdmin(net);
  setStatus("wheelStatus", `Connected as ${admin.address}. Storing code...`);

  const stored = await storeCode(admin, wasm, "wheel-manager");
  setStatus("wheelStatus", `Code ID: ${stored.codeId} (gasUsed ${stored.gasUsed}). Instantiating...`);

  const inst = await instantiate(admin, stored.codeId, `wheel-manager-${label}`, {
    ticket_price: ticketPrice,
    ticket_denom: net.ticketDenom,
    redemption_denom: net.redemptionDenom,
    min_players: minPlayers,
    max_players: maxPlayers,
    round_timeout_seconds: 3600,
    unclaimed_deadline_days: 90,
    max_round_age_seconds: 172_800,
    max_reveal_age_seconds: 3600,
    treasury_address: net.treasuryAddress,
    admin_fee_address: net.adminFeeAddress,
    weekly_round_address: weeklyRoundAddress,
    commit_pusher: commitPusherAddress,
  });

  const result = { codeId: stored.codeId.toString(), contractAddress: inst.contractAddress, maxPlayers, minPlayers, ticketPrice };
  el<HTMLTextAreaElement>("wheelOutput").value = JSON.stringify(result, null, 2);
  setStatus("wheelStatus", `Done. Address: ${inst.contractAddress} (gasUsed ${inst.gasUsed}).`);
}

// One shared lock across all 3 buttons, not 3 independent ones - all 3
// flows sign with the same admin wallet, so 2 running concurrently (e.g.
// clicking "weekly" while "cyol" is still storing/instantiating) can race
// on the account sequence, failing one flow after the other already spent
// real gas on MsgStoreCode (CodeRabbit finding, 2026-09-19 review, fourth
// round - the first round's per-button lock only stopped double-clicking
// the SAME button).
const cyolButton = el<HTMLButtonElement>("cyolButton");
const weeklyButton = el<HTMLButtonElement>("weeklyButton");
const wheelButton = el<HTMLButtonElement>("wheelButton");
const deployButtons = [cyolButton, weeklyButton, wheelButton];

function runDeploy(deploy: () => Promise<void>, statusId: string) {
  for (const button of deployButtons) button.disabled = true;
  deploy()
    .catch((err) => setStatus(statusId, err.message ?? String(err), true))
    .finally(() => {
      for (const button of deployButtons) button.disabled = false;
    });
}

cyolButton.addEventListener("click", () => runDeploy(deployCyolFactory, "cyolStatus"));
weeklyButton.addEventListener("click", () => runDeploy(deployWeeklyRound, "weeklyStatus"));
wheelButton.addEventListener("click", () => runDeploy(deployWheelManager, "wheelStatus"));
