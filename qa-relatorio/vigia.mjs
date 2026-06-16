#!/usr/bin/env node
// Vigia das automações de QA (dead-man's switch).
// Confere se cada robô rodou dentro do prazo esperado e alerta se algum "morreu"
// em silêncio (token az expirado, rate limit do claude, reboot, watcher parado).
//
// Uso:
//   node vigia.mjs              # checa e imprime; exit !=0 se algo critico estiver atrasado
//   node vigia.mjs --quiet      # so imprime/alerta se houver problema
//   VIGIA_WEBHOOK=<url Teams>    # se setado, posta um card quando houver atraso
//
// Heartbeats (sinais de "rodou"):
//   - qa-review watcher  -> mtime de /tmp/qa-watch.log         (a cada 15min)
//   - bug-triage analyze -> generatedAt de data/candidates.json (a cada 6h)
//   - bug-triage painel  -> HTTP em http://localhost:3100       (sempre no ar)
//   - relatório semanal  -> .md mais novo em reports/           (toda segunda)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const argv = process.argv.slice(2);
const quiet = argv.includes('--quiet');
const WEBHOOK = process.env.VIGIA_WEBHOOK || '';

const agora = Date.now();
const H = 3600_000, MIN = 60_000, DIA = 86400_000;
const fmtAge = (ms) => ms < H ? `${Math.round(ms / MIN)}min` : ms < DIA ? `${(ms / H).toFixed(1)}h` : `${(ms / DIA).toFixed(1)}d`;

function mtimeMs(p) { try { return fs.statSync(p).mtimeMs; } catch { return null; } }
function newestMtime(glob) {
  try {
    const dir = path.dirname(glob); const re = new RegExp('^' + path.basename(glob).replace(/\*/g, '.*') + '$');
    const files = fs.readdirSync(dir).filter((f) => re.test(f)).map((f) => fs.statSync(path.join(dir, f)).mtimeMs);
    return files.length ? Math.max(...files) : null;
  } catch { return null; }
}

const checks = [];
function add(nome, lastMs, limiteMs, extra = '') {
  if (lastMs == null) { checks.push({ nome, status: 'SEM SINAL', detalhe: 'nunca rodou / arquivo ausente' + (extra ? ` (${extra})` : ''), critico: true }); return; }
  const idade = agora - lastMs;
  const atrasado = idade > limiteMs;
  checks.push({ nome, status: atrasado ? 'ATRASADO' : 'OK', detalhe: `último há ${fmtAge(idade)} (limite ${fmtAge(limiteMs)})` + (extra ? ` ${extra}` : ''), critico: atrasado });
}

// 1. qa-review watcher (15min) -> tolerância 60min (4 ciclos)
add('qa-review watcher', mtimeMs('/tmp/qa-watch.log'), 60 * MIN);

// 2. bug-triage analyze (6h) -> tolerância 12h; usa generatedAt do candidates.json
let analyzeTs = null;
try { analyzeTs = Date.parse(JSON.parse(fs.readFileSync(path.join(HOME, 'sittax-bug-triage/data/candidates.json'), 'utf8')).generatedAt); } catch { /* sem arquivo */ }
add('bug-triage analyze', Number.isFinite(analyzeTs) ? analyzeTs : null, 12 * H);

// 3. relatório semanal -> tolerância 8 dias (roda segunda)
add('relatório semanal', newestMtime(path.join(HOME, 'qa-relatorio/reports/Relatorio-QA-*.md')), 8 * DIA);

// 4. painel de bugs (HTTP) -> assíncrono
async function checkPanel() {
  try {
    const ctrl = AbortSignal.timeout(4000);
    const res = await fetch('http://localhost:3100/', { signal: ctrl });
    checks.push({ nome: 'painel de bugs (3100)', status: res.ok ? 'OK' : 'ATRASADO', detalhe: `HTTP ${res.status}`, critico: !res.ok });
  } catch (e) {
    checks.push({ nome: 'painel de bugs (3100)', status: 'FORA DO AR', detalhe: (e.message || '').slice(0, 60), critico: true });
  }
}

async function alertaTeams(problemas) {
  if (!WEBHOOK) return;
  const text = '⚠️ **Vigia de QA — automação(ões) atrasada(s)**\n\n' +
    problemas.map((c) => `- **${c.nome}**: ${c.status} — ${c.detalhe}`).join('\n');
  try {
    await fetch(WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    console.error('  (alerta enviado ao Teams)');
  } catch (e) { console.error('  (falha ao alertar Teams:', e.message, ')'); }
}

async function main() {
  await checkPanel();
  const problemas = checks.filter((c) => c.critico);
  const status = { verificadoEm: new Date().toISOString(), ok: problemas.length === 0, checks };
  fs.writeFileSync(path.join(HOME, 'qa-relatorio/vigia-status.json'), JSON.stringify(status, null, 2), 'utf8');

  if (!quiet || problemas.length) {
    const ic = { OK: '✅', ATRASADO: '🔴', 'SEM SINAL': '🔴', 'FORA DO AR': '🔴' };
    console.log('Vigia de QA —', new Date().toLocaleString('pt-BR'));
    for (const c of checks) console.log(`  ${ic[c.status] || '❔'} ${c.nome}: ${c.status} (${c.detalhe})`);
  }
  if (problemas.length) {
    await alertaTeams(problemas);
    console.error(`\n${problemas.length} automação(ões) com problema.`);
    process.exit(1);
  } else if (!quiet) {
    console.log('\nTudo no ar. ✅');
  }
}
main();
