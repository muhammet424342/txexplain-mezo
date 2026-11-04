import w from '../src/worker.js';
const base='https://x.test';
for (const p of process.argv.slice(2)) { const r=await w.fetch(new Request(base+p)); console.log(p, r.status); console.log((await r.text()).slice(0,2500)); }
