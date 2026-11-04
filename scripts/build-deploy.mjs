// Builds dist/deploy.js for the Cloudflare MCP `execute` tool. Optional: ALERTS_CONTRACT=0x... node scripts/build-deploy.mjs
import { readFileSync, writeFileSync, mkdirSync } from "fs";
const code = readFileSync("src/worker.js", "utf8");
const a = process.env.ALERTS_CONTRACT;
if (a && !/^0x[0-9a-fA-F]{40}$/.test(a)) throw new Error("bad ALERTS_CONTRACT");
const metadata = { main_module: "worker.js", compatibility_date: "2026-11-01", bindings: a ? [{ type: "plain_text", name: "ALERTS_CONTRACT", text: a }] : [] };
const old = readFileSync("dist/deploy.js", "utf8");
const tail = old.slice(old.indexOf("const form"));
mkdirSync("dist", { recursive: true });
writeFileSync("dist/deploy.js", `async () => { const code = ${JSON.stringify(code)};\nconst metadata = ${JSON.stringify(metadata)};\n${tail}`);
console.log("ok, bindings:", metadata.bindings.length);
