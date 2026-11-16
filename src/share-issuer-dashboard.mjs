// KYC-gated real-estate share issuer. Read-only dashboard for the latest chain.
// Usage:
//   node src/share-issuer-dashboard.mjs [port]
// Serves one page on 127.0.0.1 (default port 8787). Reads runs/ only.
// Makes no ledger calls and writes no files.

import http from 'http'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RUNS = path.join(ROOT, 'runs')
const PORT = Number(process.argv[2] ?? 8787)
const EXPLORER = 'https://testnet.xrpl.org/transactions/'

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function folderNames() {
  if (!fs.existsSync(RUNS)) return []
  return fs.readdirSync(RUNS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .reverse()
}

function summarizeRun(folder) {
  const log = readJson(path.join(RUNS, folder, 'run.json'))
  if (!log) return null
  return {
    folder,
    mode: log.mode,
    result: log.result,
    error: log.error ?? null,
    steps: (log.steps ?? []).map((s) => ({
      label: s.label,
      result: s.result,
      link: s.hash ? EXPLORER + s.hash : null
    })),
    checks: (log.checks ?? []).map((c) => ({ name: c.name, ok: c.ok, detail: c.detail }))
  }
}

// The newest ledger check names the chain it verified. Show that chain.
function latestChain() {
  const verifyFolder = folderNames().find((n) => n.endsWith('-verify') && readJson(path.join(RUNS, n, 'verify.json')))
  if (!verifyFolder) return { verify: null, runs: [] }
  const verify = readJson(path.join(RUNS, verifyFolder, 'verify.json'))
  const runs = (verify.runs ?? [])
    .map((dir) => summarizeRun(path.basename(dir)))
    .filter(Boolean)
  return {
    verify: { folder: verifyFolder, result: verify.result, checks: verify.results ?? [] },
    runs
  }
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Share issuer dashboard</title>
<style>
  :root { --fg: #1f1f1e; --muted: #6b6a65; --line: #d9d7cf; --bg: #ffffff; --pass: #1d6b3a; --fail: #a32d2d; }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) { --fg: #ececea; --muted: #a3a29b; --line: #3a3a37; --bg: #161615; --pass: #7fd39c; --fail: #f09595; }
  }
  :root[data-theme="dark"] { --fg: #ececea; --muted: #a3a29b; --line: #3a3a37; --bg: #161615; --pass: #7fd39c; --fail: #f09595; }
  body { margin: 0; padding: 16px; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, sans-serif; }
  h1 { font-size: 20px; font-weight: 500; margin: 0 0 4px; }
  h2 { font-size: 16px; font-weight: 500; margin: 24px 0 8px; }
  .muted { color: var(--muted); font-size: 13px; }
  .pill { display: inline-block; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--line); font-size: 13px; }
  .pass { color: var(--pass); border-color: var(--pass); }
  .fail { color: var(--fail); border-color: var(--fail); }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  td, th { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { font-weight: 500; color: var(--muted); }
  a { color: inherit; }
  .run { border: 1px solid var(--line); border-radius: 8px; padding: 12px; margin: 8px 0; }
  .bad { color: var(--fail); }
</style>
</head>
<body>
<h1>Share issuer dashboard</h1>
<p class="muted">Read-only. Shows the chain that the last ledger check verified. Makes no ledger calls.</p>
<div id="root">Loading</div>
<script>
function el(tag, text, cls) {
  const n = document.createElement(tag);
  if (text !== undefined && text !== null) n.textContent = String(text);
  if (cls) n.className = cls;
  return n;
}
function pill(result) {
  const ok = result === 'PASS' || result === 'tesSUCCESS';
  return el('span', result, 'pill ' + (ok ? 'pass' : 'fail'));
}
function render(data) {
  const root = document.getElementById('root');
  root.textContent = '';
  if (!data.verify) {
    root.appendChild(el('p', 'No ledger check found in runs/. Run npm run share-issuer:chain first.', 'muted'));
    return;
  }
  const v = data.verify;
  const failed = v.checks.filter((c) => !c.ok).length;
  const head = el('p');
  head.appendChild(el('span', 'Last ledger check: '));
  head.appendChild(pill(v.result));
  head.appendChild(el('span', '  ' + v.checks.length + ' checks, ' + failed + ' failed', 'muted'));
  head.appendChild(el('div', 'Verify folder: ' + v.folder, 'muted'));
  root.appendChild(head);

  root.appendChild(el('h2', 'Runs in this chain'));
  for (const run of data.runs) {
    const box = el('div', null, 'run');
    const title = el('div');
    title.appendChild(el('strong', run.mode));
    title.appendChild(document.createTextNode('  '));
    title.appendChild(pill(run.result));
    box.appendChild(title);
    box.appendChild(el('div', run.folder, 'muted'));
    if (run.error) box.appendChild(el('div', 'Error: ' + run.error, 'bad'));
    if (run.steps.length) {
      const t = el('table');
      const hr = el('tr');
      hr.appendChild(el('th', 'Step'));
      hr.appendChild(el('th', 'Ledger result'));
      hr.appendChild(el('th', 'Transaction'));
      t.appendChild(hr);
      for (const s of run.steps) {
        const tr = el('tr');
        tr.appendChild(el('td', s.label));
        tr.appendChild(el('td', s.result));
        const td = el('td');
        if (s.link) {
          const a = el('a', 'view');
          a.href = s.link;
          a.target = '_blank';
          a.rel = 'noopener';
          td.appendChild(a);
        }
        tr.appendChild(td);
        t.appendChild(tr);
      }
      box.appendChild(t);
    }
    root.appendChild(box);
  }

  root.appendChild(el('h2', 'Ledger checks (' + v.checks.length + ')'));
  const ct = el('table');
  const ch = el('tr');
  ch.appendChild(el('th', 'Check'));
  ch.appendChild(el('th', 'Result'));
  ch.appendChild(el('th', 'Detail'));
  ct.appendChild(ch);
  for (const c of v.checks) {
    const tr = el('tr');
    tr.appendChild(el('td', c.name));
    const r = el('td');
    r.appendChild(pill(c.ok ? 'PASS' : 'FAIL'));
    tr.appendChild(r);
    tr.appendChild(el('td', c.detail, 'muted'));
    ct.appendChild(tr);
  }
  root.appendChild(ct);
}
fetch('/api/chain').then((r) => r.json()).then(render).catch((e) => {
  document.getElementById('root').textContent = 'Could not load /api/chain: ' + e;
});
</script>
</body>
</html>
`

const server = http.createServer((req, res) => {
  if (req.method !== 'GET') {
    res.writeHead(405, { 'content-type': 'text/plain' })
    res.end('read-only')
    return
  }
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname === '/api/chain') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(latestChain()))
    return
  }
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(PAGE)
    return
  }
  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end('not found')
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`share issuer dashboard: http://127.0.0.1:${PORT}/ (read-only, Ctrl+C to stop)`)
})
