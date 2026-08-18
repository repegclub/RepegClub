#!/usr/bin/env bash
# Read-only check of real onramp usage: since the 0.2% fee rides in the same
# signature as every direct-transfer (Noble/Cosmos Hub/Osmosis), the
# fee-keeper/treasury wallets' tx history IS the usage log - no backend
# needed. EVM (Ethereum/Arbitrum/Base) checked separately since the widget's
# fee doesn't reliably fire there for plain USDC transfers (see project notes).
#
# No associative arrays here on purpose - macOS ships bash 3.2 by default,
# which doesn't support declare -A.
set -euo pipefail

echo "=== Direct-transfer chains (Noble / Cosmos Hub / Osmosis) ==="

CHAINS="noble osmosis cosmoshub"
noble_addr="noble1h3898lq8fyspnlvpwknl9ffu8pttyjvx3eet8a"
osmosis_addr="osmo1h3898lq8fyspnlvpwknl9ffu8pttyjvx3plnfp"
cosmoshub_addr="cosmos1h3898lq8fyspnlvpwknl9ffu8pttyjvxe6vrln"

for chain in $CHAINS; do
  addr_var="${chain}_addr"
  addr="${!addr_var}"
  echo
  echo "--- $chain fee-keeper ($addr) ---"
  curl -s "https://rest.cosmos.directory/$chain/cosmos/tx/v1beta1/txs?query=transfer.recipient%3D%27${addr}%27&order_by=ORDER_BY_ASC&pagination.limit=100" \
    | python3 -c "
import json, sys
d = json.load(sys.stdin)
resps = d.get('tx_responses', [])
print(f'  {len(resps)} incoming tx(s)')
for tx in resps:
    print(f\"    {tx.get('timestamp')}  {tx.get('txhash')}\")
"
done

echo
echo "=== EVM chains (Ethereum / Arbitrum / Base) ==="
echo "Fee is known-broken for plain USDC transfers on these - balance check only."

FEE_KEEPER_EVM="0x7Ba128C90A0633Ff8E7277f6C35D9Cb27Db6bdf3"
TREASURY_EVM="0xC14112fB044A9353e9F9896Ab22F9F388A62ada3"

check_evm() {
  name="$1"; rpc="$2"; usdc="$3"
  python3 -c "
import json, urllib.request

def balance_of(rpc, contract, holder):
    data = '0x70a08231' + '000000000000000000000000' + holder[2:].lower()
    payload = json.dumps({'jsonrpc':'2.0','method':'eth_call','params':[{'to':contract,'data':data},'latest'],'id':1}).encode()
    req = urllib.request.Request(rpc, data=payload, headers={'Content-Type':'application/json','User-Agent':'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=15) as r:
        result = json.loads(r.read()).get('result')
        return int(result, 16) / 1_000_000 if result else 'error'

fk = balance_of('$rpc', '$usdc', '$FEE_KEEPER_EVM')
tr = balance_of('$rpc', '$usdc', '$TREASURY_EVM')
print(f'  $name: fee-keeper={fk} USDC  treasury={tr} USDC')
"
}

check_evm "Ethereum" "https://ethereum.publicnode.com" "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
check_evm "Arbitrum" "https://arb1.arbitrum.io/rpc" "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"
check_evm "Base" "https://mainnet.base.org" "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
