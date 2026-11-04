// TxExplain for Mezo — read-only MUSD trove & tx explainer (Mezo testnet).
// Written from 4 Nov 2026 onward. No keys, no wallet, no writes: only eth_call / eth_getTransaction*.

const NET = {
  chainId: 31611,
  rpc: "https://rpc.test.mezo.org",
  explorer: "https://explorer.test.mezo.org",
};
// Source: mezo-org/documentation, docs/developers/musd/musd-redemptions (Contract Addresses, Testnet column)
const C = {
  troveManager: "0xe47c80e8c23f6b4a1ae41c34837a0599d5d16bb0",
  borrowerOperations: "0xcdf7028ceab81fa0c6971208e83fa7872994bee5",
  sortedTroves: "0x722e4d24fd6ff8b0ac679450f3d91294607268fa",
  priceFeed: "0x86bcf0841622a5dac14a313a15f96a95421b9366",
  hintHelpers: "0x4e4cba3779d56386ed43631b4dcd6d8eacecbcf6",
  musd: "0x118917a40faf1cd7a13db0ef56c86de7973ac503",
};
const LABEL = Object.fromEntries(Object.entries(C).map(([k, v]) => [v, k]));
// Protocol constants from mezo-org/musd solidity/contracts/dependencies/LiquityBase.sol
const MCR = 110n * 10n ** 16n; // 110%
const CCR = 150n * 10n ** 16n; // 150%
const GAS_COMP = 200n * 10n ** 18n;
const E18 = 10n ** 18n;

// 4-byte selectors (keccak256 of signatures, computed in scripts/selectors.mjs)
const SEL = {
  getEntireDebtAndColl: "0xb91af97c",
  getCurrentICR: "0xd293c710",
  getTroveStatus: "0x21e37801",
  getTroveInterestRate: "0x92b7659b",
  fetchPrice: "0x0fdb11cf",
  minNetDebt: "0x969c2452",
  getSize: "0xde8fa431",
  getFirst: "0x1e223143",
  getNext: "0x765e0159",
  getTCR: "0xb82f263d",
};
const FN = {
  "0x2f3a6d98": "openTrove", "0x68647db1": "addColl", "0x5530273c": "withdrawColl",
  "0xaf8b4fd0": "withdrawMUSD", "0xdc283bb3": "repayMUSD", "0x0e704d50": "closeTrove",
  "0x45c842e6": "adjustTrove", "0xdc1cdb2c": "refinance",
};
const TOPIC = {
  "0x85a52d2a9df6d50beea0d12f454309d08739d01fde1aa65491f68b92367297b4": "TroveUpdated",
  "0xea67486ed7ebe3eea8ab3390efd4a3c8aae48be5bea27df104a8af786c408434": "TroveLiquidated",
  "0x59cfd0cd754bc5748b6770e94a4ffa5f678d885cb899dcfadc5734edb97c67ab": "TroveCreated",
  "0x5d032cf8244d18503d44f7171954f352ff41fa2df69660eb897f4db36efe808e": "BorrowingFeePaid",
  "0xde81352e4f17b151de0a2f2a30a50eeb111a437414e8f241248158063302a551": "RefinancingFeePaid",
  "0x43a3f4082a4dbc33d78e317d2497d3a730bc7fc3574159dcea1056e62e5d9ad8": "Redemption",
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef": "Transfer",
};
const BO_OP = ["opened", "closed", "adjusted", "refinanced"];
const TM_OP = ["pending rewards applied", "liquidated", "redeemed against"];
const STATUS = ["nonExistent", "active", "closedByOwner", "closedByLiquidation", "closedByRedemption"];

let rid = 0;
async function rpc(method, params) {
  const r = await fetch(NET.rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rid, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`rpc ${method}: ${j.error.message}`);
  return j.result;
}
const ethCall = (to, data) => rpc("eth_call", [{ to, data }, "latest"]);
const pad = (hex) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const words = (hex) => (hex.replace(/^0x/, "").match(/.{64}/g) || []).map((w) => BigInt("0x" + w));
const addrWord = (w) => "0x" + w.slice(-40);

function fmt(v, dp = 4, dec = 18) {
  const neg = v < 0n; if (neg) v = -v;
  const base = 10n ** BigInt(dec);
  const s = (v / base).toLocaleString("en-US");
  const frac = (v % base).toString().padStart(dec, "0").slice(0, dp).replace(/0+$/, "");
  return (neg ? "-" : "") + s + (frac ? "." + frac : "");
}
const pct = (r) => fmt(r * 100n, 2);

async function system() {
  const [p, mnd, size] = await Promise.all([
    ethCall(C.priceFeed, SEL.fetchPrice),
    ethCall(C.borrowerOperations, SEL.minNetDebt),
    ethCall(C.sortedTroves, SEL.getSize),
  ]);
  const price = BigInt(p);
  const tcr = BigInt(await ethCall(C.troveManager, SEL.getTCR + pad(price.toString(16))));
  return { price, minNetDebt: BigInt(mnd), troves: Number(BigInt(size)), tcr };
}

async function trove(addr) {
  const a = pad(addr);
  const sys = await system();
  const [dc, st, ir, icr] = await Promise.all([
    ethCall(C.troveManager, SEL.getEntireDebtAndColl + a),
    ethCall(C.troveManager, SEL.getTroveStatus + a),
    ethCall(C.troveManager, SEL.getTroveInterestRate + a),
    ethCall(C.troveManager, SEL.getCurrentICR + a + pad(sys.price.toString(16))),
  ]);
  const [coll, principal, interest, pColl, pPrin, pInt] = words(dc);
  const status = STATUS[Number(BigInt(st))] || "unknown";
  const out = {
    network: "Mezo testnet (chainId 31611)",
    borrower: addr,
    status,
    btcPriceUsd: fmt(sys.price, 2),
    explorer: `${NET.explorer}/address/${addr}`,
  };
  if (status !== "active") {
    out.explanation = status === "nonExistent"
      ? "This address has never opened an MUSD borrow position (trove) on Mezo testnet."
      : `This trove is no longer active (${status}). Nothing is borrowed against it now.`;
    return out;
  }
  const totalColl = coll + pColl;
  const debt = principal + interest + pPrin + pInt;
  const ratio = BigInt(icr); // 1e18 = 100%
  const liqPrice = totalColl > 0n ? (debt * MCR) / totalColl : 0n;
  const drop = sys.price > 0n && liqPrice < sys.price ? ((sys.price - liqPrice) * E18) / sys.price : 0n;
  const recovery = sys.tcr < CCR;
  let risk, riskText;
  if (ratio < MCR) { risk = "LIQUIDATABLE"; riskText = "Below the 110% minimum. Anyone can liquidate this trove right now."; }
  else if (recovery && ratio < sys.tcr) { risk = "HIGH"; riskText = "System is in Recovery Mode and this trove is below the system ratio, so it can be liquidated."; }
  else if (ratio < CCR) { risk = "HIGH"; riskText = "Under 150%. A modest BTC drop could push it under 110% and trigger liquidation."; }
  else if (ratio < 200n * 10n ** 16n) { risk = "MEDIUM"; riskText = "Between 150% and 200%. Safe today, but watch BTC price swings."; }
  else { risk = "LOW"; riskText = "Above 200%. BTC would need to fall a lot before liquidation."; }
  Object.assign(out, {
    collateralBtc: fmt(totalColl, 8),
    collateralUsd: fmt((totalColl * sys.price) / E18, 2),
    debtMusd: fmt(debt, 2),
    debtBreakdown: { principal: fmt(principal + pPrin, 2), interest: fmt(interest + pInt, 4), includesGasCompensation: fmt(GAS_COMP, 0) },
    interestRateBps: Number(BigInt(ir)),
    collateralRatioPct: pct(ratio),
    liquidationPriceUsd: fmt(liqPrice, 2),
    btcDropToLiquidationPct: pct(drop),
    risk,
    system: { totalCollateralRatioPct: pct(sys.tcr), recoveryMode: recovery, activeTroves: sys.troves, minNetDebtMusd: fmt(sys.minNetDebt, 0) },
  });
  out.explanation =
    `This wallet has ${out.collateralBtc} BTC (~$${out.collateralUsd}) locked and owes ${out.debtMusd} MUSD ` +
    `(incl. ${out.debtBreakdown.interest} MUSD interest at ${(out.interestRateBps / 100).toFixed(2)}% APR and the 200 MUSD liquidation reserve). ` +
    `Its collateral ratio is ${out.collateralRatioPct}%. It gets liquidated if BTC falls to $${out.liquidationPriceUsd} ` +
    `(${out.btcDropToLiquidationPct}% below today's $${out.btcPriceUsd}). Risk: ${risk}. ${riskText}`;
  return out;
}

async function tx(hash) {
  const [t, r] = await Promise.all([
    rpc("eth_getTransactionByHash", [hash]),
    rpc("eth_getTransactionReceipt", [hash]),
  ]);
  if (!t) return { error: "Transaction not found via the public Mezo testnet RPC (wrong hash, other network, or not served by this RPC node)", hash };
  const to = (t.to || "").toLowerCase();
  const sel = (t.input || "0x").slice(0, 10);
  const fn = FN[sel] || null;
  const value = BigInt(t.value || "0x0");
  const events = [];
  const lines = [];
  let borrower = null;
  for (const lg of r?.logs || []) {
    const name = TOPIC[lg.topics[0]];
    const src = lg.address.toLowerCase();
    if (!name) continue;
    const w = words(lg.data);
    if (name === "TroveUpdated") {
      borrower = addrWord(lg.topics[1]);
      const fromBO = src === C.borrowerOperations;
      const op = fromBO ? BO_OP[Number(w[6])] : TM_OP[Number(w[6])];
      events.push({ event: name, contract: LABEL[src] || src, borrower, principal: fmt(w[0], 2), interest: fmt(w[1], 4), collBtc: fmt(w[2], 8), interestRateBps: Number(w[4]), operation: op });
      lines.push(`Trove of ${borrower} was ${op}: now ${fmt(w[2], 8)} BTC collateral, ${fmt(w[0] + w[1], 2)} MUSD debt.`);
    } else if (name === "TroveLiquidated") {
      events.push({ event: name, borrower: addrWord(lg.topics[1]), debt: fmt(w[0], 2), collBtc: fmt(w[1], 8) });
      lines.push(`Trove ${addrWord(lg.topics[1])} was liquidated (${fmt(w[0], 2)} MUSD debt, ${fmt(w[1], 8)} BTC).`);
    } else if (name === "BorrowingFeePaid" || name === "RefinancingFeePaid") {
      events.push({ event: name, fee: fmt(w[0], 4) });
      if (w[0] > 0n) lines.push(`${name === "BorrowingFeePaid" ? "Borrowing" : "Refinancing"} fee: ${fmt(w[0], 4)} MUSD.`);
    } else if (name === "Redemption") {
      events.push({ event: name, musdRedeemed: fmt(w[1], 2), btcSent: fmt(w[2], 8) });
      lines.push(`${fmt(w[1], 2)} MUSD redeemed for ${fmt(w[2], 8)} BTC.`);
    } else if (name === "Transfer" && src === C.musd) {
      const from = addrWord(lg.topics[1]), toA = addrWord(lg.topics[2]);
      const zero = /^0x0{40}$/;
      const kind = zero.test(from) ? "minted" : zero.test(toA) ? "burned" : "transferred";
      events.push({ event: "MUSD " + kind, from, to: toA, amount: fmt(w[0], 2) });
      lines.push(`${fmt(w[0], 2)} MUSD ${kind}${kind === "transferred" ? ` from ${from} to ${toA}` : ""}.`);
    }
  }
  const ok = r ? r.status === "0x1" : null;
  const head = fn
    ? `${t.from} called BorrowerOperations.${fn}${value ? ` sending ${fmt(value, 8)} BTC as collateral` : ""}.`
    : `${t.from} sent a transaction to ${LABEL[to] || to}${value ? ` with ${fmt(value, 8)} BTC` : ""}.`;
  return {
    network: "Mezo testnet (chainId 31611)",
    hash, status: ok === null ? "pending" : ok ? "success" : "failed",
    block: t.blockNumber ? parseInt(t.blockNumber, 16) : null,
    from: t.from, to: t.to, contract: LABEL[to] || null, function: fn, valueBtc: fmt(value, 8),
    musdRelated: !!(fn || events.length),
    events, borrower,
    explanation: [head, ...lines, ok === false ? "The transaction reverted; nothing changed." : ""].filter(Boolean).join(" "),
    trovePath: borrower ? `/api/trove/${borrower}` : null,
    explorer: `${NET.explorer}/tx/${hash}`,
  };
}

const J = (o, s = 200) => new Response(JSON.stringify(o, null, 2), { status: s, headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "cache-control": "no-store" } });

// Optional on-chain alert registry (contracts/src/TroveAlertRegistry.sol). Disabled unless the
// ALERTS_CONTRACT plain-text env var holds a 0x address of a deployed registry on Mezo testnet.
const CHECK_SEL = "0xc23697a8"; // check(address)
const alertsAddr = (env) => { const a = env && env.ALERTS_CONTRACT; return a && /^0x[0-9a-fA-F]{40}$/.test(a) ? a.toLowerCase() : null; };
async function alerts(reg, addr) {
  const [active, icr, threshold, below, liq] = words(await ethCall(reg, CHECK_SEL + pad(addr)));
  return { registry: reg, borrower: addr, troveActive: active === 1n, icrPct: pct(icr), alertThresholdPct: threshold ? pct(threshold) : null, belowThreshold: below === 1n, liquidatable: liq === 1n, explorer: `${NET.explorer}/address/${reg}` };
}

export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    const p = u.pathname;
    try {
      if (p === "/" ) return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
      if (p === "/api/health") return J({ ok: true, network: NET, contracts: C, block: parseInt(await rpc("eth_blockNumber", []), 16) });
      if (p === "/api/system") { const s = await system(); return J({ btcPriceUsd: fmt(s.price, 2), totalCollateralRatioPct: pct(s.tcr), recoveryMode: s.tcr < CCR, activeTroves: s.troves, minNetDebtMusd: fmt(s.minNetDebt, 0), gasCompensationMusd: "200", mcrPct: "110", ccrPct: "150" }); }
      if (p === "/api/sample") { const first = addrWord(pad(await ethCall(C.sortedTroves, SEL.getFirst))); return J({ borrower: first, trovePath: `/api/trove/${first}` }); }
      let m;
      if ((m = p.match(/^\/api\/trove\/(0x[0-9a-fA-F]{40})$/))) return J(await trove(m[1].toLowerCase()));
      if ((m = p.match(/^\/api\/tx\/(0x[0-9a-fA-F]{64})$/))) return J(await tx(m[1].toLowerCase()));
      if ((m = p.match(/^\/api\/alerts\/(0x[0-9a-fA-F]{40})$/))) { const reg = alertsAddr(env); if (!reg) return J({ enabled: false, error: "Alert registry not deployed yet (ALERTS_CONTRACT unset)" }, 503); return J(await alerts(reg, m[1].toLowerCase())); }
      if (p.startsWith("/api/")) return J({ error: "Use /api/trove/<address> or /api/tx/<hash>" }, 400);
      return J({ error: "not found" }, 404);
    } catch (e) {
      return J({ error: String(e.message || e) }, 502);
    }
  },
};

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TxExplain for Mezo — MUSD position explainer</title>
<style>body{font-family:system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 16px;background:#0f0f12;color:#eee}
h1{margin-bottom:4px}small{color:#999}input{width:100%;padding:12px;font-size:15px;border-radius:8px;border:1px solid #444;background:#1b1b20;color:#eee;box-sizing:border-box}
button{margin-top:10px;padding:10px 18px;border:0;border-radius:8px;background:#ff004d;color:#fff;font-weight:600;cursor:pointer}
#out p{font-size:17px;line-height:1.5;background:#1b1b20;padding:14px;border-radius:8px}pre{background:#16161a;padding:12px;border-radius:8px;overflow:auto;font-size:12px}
.b{display:inline-block;padding:2px 8px;border-radius:6px;font-weight:700}.LOW{background:#1f7a3a}.MEDIUM{background:#a07a00}.HIGH,.LIQUIDATABLE{background:#b3122e}a{color:#ff6b8f}</style></head>
<body><h1>TxExplain for Mezo</h1><small>Paste a Mezo testnet borrower address or tx hash. Read-only: no wallet, no signing.</small>
<p><input id="q" placeholder="0x… address (trove) or 0x… tx hash"><button id="go">Explain</button> <button id="s" style="background:#333">Try a live trove</button></p>
<div id="out"></div>
<p><small>Data: Mezo testnet RPC + official MUSD contracts (TroveManager, BorrowerOperations, PriceFeed, SortedTroves). API: <code>/api/trove/&lt;address&gt;</code>, <code>/api/tx/&lt;hash&gt;</code>, <code>/api/system</code>. Not financial advice.</small></p>
<script>
const o=document.getElementById('out'),q=document.getElementById('q');
async function run(v){v=v.trim();const path=v.length===66?'/api/tx/'+v:'/api/trove/'+v;o.innerHTML='<p>Reading Mezo testnet…</p>';
const r=await fetch(path);const d=await r.json();const esc=s=>String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
o.innerHTML=(d.risk?'<span class="b '+d.risk+'">'+d.risk+'</span>':'')+'<p>'+esc(d.explanation||d.error)+'</p>'+(d.explorer?'<a target=_blank href="'+d.explorer+'">View on explorer</a>':'')+(d.trovePath?' · <a href="#" onclick="run(\\''+d.borrower+'\\');return false">Explain this trove</a>':'')+'<pre>'+esc(JSON.stringify(d,null,2))+'</pre>';}
document.getElementById('go').onclick=()=>run(q.value);q.onkeydown=e=>{if(e.key==='Enter')run(q.value)};
document.getElementById('s').onclick=async()=>{const d=await (await fetch('/api/sample')).json();q.value=d.borrower;run(d.borrower)};
</script></body></html>`;
