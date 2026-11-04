#!/usr/bin/env bash
# Deploy TroveAlertRegistry to Mezo TESTNET and switch on /api/alerts in the Worker.
#   Real:    MEZO_PK=0x... ./scripts/deploy-alerts.sh
#   Dry-run: ./scripts/deploy-alerts.sh --dry-run      (no key, no funds: local anvil fork of Mezo testnet)
# The key is read only from $MEZO_PK, never echoed, logged or written to disk.
set +x
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
DRY=0; [[ "${1:-}" == "--dry-run" ]] && DRY=1
RPC="${MEZO_RPC:-https://rpc.test.mezo.org}"
CHAIN=31611                                  # Mezo testnet; mainnet is 31612 and is refused
TM=0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0
PF=0x86bCF0841622a5dAC14A313a15f96A95421b9366
SAMPLE=0xca46BC7646fD202F0E20e0c8CE16093A3C4D33C6
EXPLORER=https://explorer.test.mezo.org
WORKER=https://txexplain-mezo.muhammetkarakurt1234.workers.dev
say(){ printf '\n== %s\n' "$*"; }
die(){ printf 'HATA: %s\n' "$*" >&2; exit 1; }

say "1/7 Ön kontroller"
for b in forge cast node; do command -v $b >/dev/null || die "$b yok (foundryup / node kur)"; done
[[ $DRY == 1 ]] && { command -v anvil >/dev/null || die "anvil yok"; }
echo "forge, cast, node: OK"
[[ "$RPC" == *mainnet* || "$RPC" == "https://rpc.mezo.org"* ]] && die "mainnet RPC reddedildi: $RPC"
cid=$(cast chain-id --rpc-url "$RPC") || die "RPC'ye ulaşılamadı"
[[ "$cid" == "$CHAIN" ]] || die "chain id $cid; yalnızca Mezo testnet ($CHAIN) kabul"
echo "RPC chain id $cid (Mezo testnet): OK"

if [[ $DRY == 1 ]]; then
  say "DRY-RUN: Mezo testnet fork'u ile anvil başlatılıyor (yerel, gerçek işlem yok)"
  price=$(cast call $PF "fetchPrice()(uint256)" --rpc-url "$RPC" | awk '{print $1}')
  cfg=$(mktemp); anvil --fork-url "$RPC" --port 8546 --silent --config-out "$cfg" & APID=$!
  trap 'kill $APID 2>/dev/null; rm -f "$cfg"' EXIT
  for i in $(seq 30); do cast chain-id --rpc-url http://127.0.0.1:8546 >/dev/null 2>&1 && break; sleep 1; done
  RPC=http://127.0.0.1:8546
  # Mezo's oracle precompile is not emulated by anvil: pin PriceFeed to the live price.
  cast rpc anvil_setCode $PF "0x7f$(cast to-uint256 "$price" | sed s/^0x//)60005260206000f3" --rpc-url $RPC >/dev/null
  MEZO_PK=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).private_keys[0])' "$cfg")   # anvil's public test key
  echo "fork chain id: $(cast chain-id --rpc-url $RPC), fiyat sabitlendi: $price"
fi
[[ -n "${MEZO_PK:-}" ]] || die "MEZO_PK env tanımlı değil (ya da --dry-run kullan)"
FROM=$(cast wallet address --private-key "$MEZO_PK")
bal=$(cast balance "$FROM" --rpc-url "$RPC")
[[ "$bal" != "0" ]] || die "bakiye 0: $FROM için https://faucet.test.mezo.org/ kullan"
echo "deployer $FROM bakiye $(cast from-wei "$bal") BTC: OK"

say "2/7 forge build"
cd contracts && forge build -q && echo "build OK"

say "3/7 forge create --broadcast"
out=$(forge create src/TroveAlertRegistry.sol:TroveAlertRegistry --rpc-url "$RPC" --private-key "$MEZO_PK" \
      --broadcast --constructor-args $TM $PF 2>&1) || { echo "$out" | grep -v -i "private" >&2; die "forge create başarısız"; }
unset MEZO_PK
ADDR=$(echo "$out" | awk '/Deployed to:/{print $3}')
TXH=$(echo "$out" | awk '/Transaction hash:/{print $3}')
[[ "$ADDR" =~ ^0x[0-9a-fA-F]{40}$ ]] || die "adres okunamadı"
echo "kontrat: $ADDR  tx: $TXH"
cd "$ROOT"
OUTF=deployments/mezo-testnet.json; [[ $DRY == 1 ]] && OUTF=deployments/mezo-testnet.dryrun.json
node -e 'const [f,a,t,d,dry]=process.argv.slice(1);require("fs").writeFileSync(f,JSON.stringify({network:"mezo-testnet",chainId:31611,TroveAlertRegistry:a,tx:t,deployer:d,constructorArgs:{troveManager:"0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0",priceFeed:"0x86bCF0841622a5dAC14A313a15f96A95421b9366"},dryRun:dry==="1",date:new Date().toISOString()},null,2)+"\n")' "$OUTF" "$ADDR" "$TXH" "$FROM" "$DRY"
echo "yazıldı: $OUTF"

say "4/7 Blockscout verify"
if [[ $DRY == 1 ]]; then echo "(dry-run: atlandı; gerçek çalıştırmada forge verify-contract --verifier blockscout)"
else
  (cd contracts && forge verify-contract "$ADDR" src/TroveAlertRegistry.sol:TroveAlertRegistry --chain-id $CHAIN \
     --verifier blockscout --verifier-url https://api.explorer.test.mezo.org/api/ \
     --constructor-args "$(cast abi-encode 'c(address,address)' $TM $PF)" --watch) \
   && echo "verify OK" || echo "UYARI: verify başarısız; sonra tekrar dene, devam ediliyor"
fi

say "5/7 check() smoke testi"
res=$(cast call "$ADDR" "check(address)(bool,uint256,uint256,bool,bool)" $SAMPLE --rpc-url "$RPC")
echo "$res" | tr '\n' ' '; echo
[[ "$(echo "$res" | head -1)" == "true" ]] || die "check(): örnek trove aktif değil"

say "6/7 Worker (ALERTS_CONTRACT=$ADDR)"
ALERTS_CONTRACT=$ADDR node scripts/build-deploy.mjs >/dev/null && echo "dist/deploy.js üretildi (binding dahil)"
if [[ $DRY == 1 ]]; then echo "(dry-run: Cloudflare deploy atlandı)"
elif npx -y wrangler@4 whoami 2>/dev/null | grep -qi "logged in"; then
  npx -y wrangler@4 deploy --var ALERTS_CONTRACT:"$ADDR"
  sleep 5
  curl -s "$WORKER/api/alerts/$SAMPLE" | tee /dev/stderr | grep -q '"troveActive": true' && echo "/api/alerts: enabled OK" \
    || echo "UYARI: /api/alerts beklenen yanıtı vermedi"
else
  echo "Cloudflare girişi yok: 'npx wrangler login' yapıp tekrar çalıştır, ya da adresi Grok Bot'a ilet; Worker'ı o deploy eder."
fi

say "7/7 Özet"
echo "Explorer:  $EXPLORER/address/$ADDR"
echo "Worker:    $WORKER/api/alerts/$SAMPLE"
[[ $DRY == 1 ]] && echo "DRY-RUN tamam: gerçek zincire hiçbir şey gönderilmedi." \
  || echo "Commit et: git add deployments/mezo-testnet.json && git commit -m 'Deploy TroveAlertRegistry to Mezo testnet'"
