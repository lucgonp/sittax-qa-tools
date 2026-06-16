#!/usr/bin/env node
// Relatorio Semanal de QA — coleta no Azure DevOps + comparativo com a semana anterior
// + narrativa gerada pelo Claude a partir dos numeros. Pensado para rodar agendado.
//
// Uso:
//   node relatorio.mjs                       # semana passada (seg-dom), comparada com a retrasada
//   node relatorio.mjs --week-start 2026-06-08   # forca o inicio da semana (segunda)
//   node relatorio.mjs --no-claude           # so os numeros/tabelas, sem narrativa
//   node relatorio.mjs --model claude-fable-5
//
// Auth: env ADO_TOKEN/SYSTEM_ACCESSTOKEN (pipeline) ou `az login` (local).
// Saida: reports/Relatorio-QA-<ini>_a_<fim>.md (+ .json com os dados crus).

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const ORG = 'https://dev.azure.com/Sittax';
const PROJECT = 'Sittax';
const ADO_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798';
const REPO_SITTAX = '12432724-c815-4561-b014-9f584316f53a';
const proj = encodeURIComponent(PROJECT);

// ---------- args ----------
const argv = process.argv.slice(2);
const flags = { model: 'claude-sonnet-4-6', claude: true, weekStart: null, copyTo: '/mnt/c/Users/New User/Desktop' };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--model') flags.model = argv[++i];
  else if (a === '--no-claude') flags.claude = false;
  else if (a === '--week-start') flags.weekStart = argv[++i];
  else if (a === '--copy-to') flags.copyTo = argv[++i]; // pasta extra p/ copiar o .md (ex.: Area de Trabalho)
  else if (a === '--no-copy') flags.copyTo = '';
}

// ---------- janela de datas (segunda 00:00 UTC a segunda seguinte) ----------
function lastMondayUTC(ref) {
  const d = new Date(ref);
  const dow = d.getUTCDay(); // 0=dom .. 1=seg
  const diffToMonday = (dow + 6) % 7; // dias desde a ultima segunda
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - diffToMonday));
  return monday;
}
const now = new Date();
// inicio da semana-alvo: a segunda da SEMANA PASSADA (a semana cheia anterior a atual)
let weekStart = flags.weekStart
  ? new Date(flags.weekStart + 'T00:00:00Z')
  : new Date(lastMondayUTC(now).getTime() - 7 * 86400000);
const weekEnd = new Date(weekStart.getTime() + 7 * 86400000);
const prevStart = new Date(weekStart.getTime() - 7 * 86400000);
const iso = (d) => d.toISOString();
const ymd = (d) => d.toISOString().slice(0, 10);
const dmy = (d) => { const [y, m, dd] = ymd(d).split('-'); return `${dd}/${m}`; };
// fim "inclusivo" exibido = domingo (weekEnd - 1 dia)
const weekEndDisplay = new Date(weekEnd.getTime() - 86400000);

// ---------- azure ----------
let _token = null;
async function token() {
  if (_token) return _token;
  const envTok = process.env.ADO_TOKEN || process.env.SYSTEM_ACCESSTOKEN;
  if (envTok) return (_token = envTok.trim());
  const { stdout } = await execFileP('az', ['account', 'get-access-token', '--resource', ADO_RESOURCE, '--query', 'accessToken', '-o', 'tsv'], { maxBuffer: 4 * 1024 * 1024 });
  _token = stdout.trim();
  if (!_token) throw new Error('Token vazio do az. Rode: az login (ou defina ADO_TOKEN).');
  return _token;
}
async function ado(url, opts = {}) {
  const t = await token();
  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers: { Authorization: `Bearer ${t}`, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw new Error(`Azure ${opts.method || 'GET'} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}
async function wiqlIds(query) {
  const r = await ado(`${ORG}/${proj}/_apis/wit/wiql?api-version=7.1`, { method: 'POST', body: { query } });
  return (r.workItems || []).map((w) => w.id);
}
const FIELDS = ['System.Id', 'System.WorkItemType', 'System.Title', 'System.State', 'System.CreatedBy', 'System.CreatedDate', 'System.ChangedDate', 'System.Tags', 'Microsoft.VSTS.Common.Severity', 'Custom.Produto', 'Custom.Prioridade', 'Custom.Area'];
async function fields(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 200) {
    const batch = await ado(`${ORG}/_apis/wit/workitemsbatch?api-version=7.1`, { method: 'POST', body: { ids: ids.slice(i, i + 200), fields: FIELDS } });
    out.push(...(batch.value || []));
  }
  return out;
}
const F = (w, k, d = '—') => (w.fields?.[k] ?? d);

// ---------- queries de uma janela ----------
const W = (col, a, b) => `[${col}] >= '${iso(a)}' AND [${col}] < '${iso(b)}'`;
const isBug = `[System.WorkItemType] IN ('Bug','SI BUG')`;
const PJ = `[System.TeamProject] = '${PROJECT}'`;

async function coletaJanela(a, b) {
  const [criados, resolvidos, producao, qaCriados, testcases] = await Promise.all([
    wiqlIds(`SELECT [System.Id] FROM WorkItems WHERE ${PJ} AND ${isBug} AND ${W('System.CreatedDate', a, b)}`),
    wiqlIds(`SELECT [System.Id] FROM WorkItems WHERE ${PJ} AND ${isBug} AND ${W('Microsoft.VSTS.Common.ClosedDate', a, b)}`),
    wiqlIds(`SELECT [System.Id] FROM WorkItems WHERE ${PJ} AND [System.Tags] CONTAINS 'producao' AND ${W('System.CreatedDate', a, b)}`),
    wiqlIds(`SELECT [System.Id] FROM WorkItems WHERE ${PJ} AND [System.CreatedBy] = 'lucas.gontijo@sittax.com.br' AND ${W('System.CreatedDate', a, b)}`),
    wiqlIds(`SELECT [System.Id] FROM WorkItems WHERE ${PJ} AND [System.WorkItemType] IN ('Test Case','Teste E2E') AND ${W('System.CreatedDate', a, b)}`),
  ]);
  // reprovadas/reincidentes: por ChangedDate (atividade no periodo)
  const [reprovadas, reincidentes] = await Promise.all([
    wiqlIds(`SELECT [System.Id] FROM WorkItems WHERE ${PJ} AND [System.Tags] CONTAINS 'reprovada-sem-teste' AND ${W('System.ChangedDate', a, b)}`),
    wiqlIds(`SELECT [System.Id] FROM WorkItems WHERE ${PJ} AND [System.Tags] CONTAINS 'reincidente' AND ${W('System.ChangedDate', a, b)}`),
  ]);
  return { criados, resolvidos, producao, qaCriados, testcases, reprovadas, reincidentes };
}

async function prsCompletados(a, b) {
  const r = await ado(`${ORG}/${proj}/_apis/git/repositories/${REPO_SITTAX}/pullrequests?searchCriteria.status=completed&$top=200&api-version=7.1`);
  return (r.value || []).filter((p) => { const d = p.closedDate || ''; return d >= iso(a) && d < iso(b); })
    .map((p) => ({ id: p.pullRequestId, title: p.title, closed: (p.closedDate || '').slice(0, 10) }));
}

function dist(items, key, transform = (x) => x) {
  const c = {};
  for (const w of items) { const v = transform(F(w, key)); c[v] = (c[v] || 0) + 1; }
  return Object.entries(c).sort((a, b) => b[1] - a[1]);
}

// ---------- claude (narrativa) ----------
function runClaude(prompt, model) {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['-p', '--output-format', 'json', '--model', model], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => reject(new Error(`claude: ${e.message}`)));
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`claude saiu ${code}: ${(err || out).slice(0, 200)}`));
      try { const env = JSON.parse(out); resolve(typeof env.result === 'string' ? env.result : out); } catch { resolve(out); }
    });
    child.stdin.write(prompt); child.stdin.end();
  });
}
function extractJson(t) {
  let r = t.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const s = r.search(/[{[]/); if (s > 0) r = r.slice(s);
  const e = Math.max(r.lastIndexOf('}'), r.lastIndexOf(']')); if (e >= 0) r = r.slice(0, e + 1);
  return JSON.parse(r);
}

const delta = (cur, prev) => { const d = cur - prev; return d === 0 ? '→ igual' : d > 0 ? `↑ +${d}` : `↓ ${d}`; };
const tbl = (rows) => rows.map(([k, v]) => `| ${k} | ${v} |`).join('\n');

async function main() {
  console.error(`Janela: ${ymd(weekStart)} a ${ymd(weekEndDisplay)} (UTC) | comparada com ${ymd(prevStart)}..${ymd(weekStart)}`);
  console.error('Coletando semana-alvo...');
  const cur = await coletaJanela(weekStart, weekEnd);
  console.error('Coletando semana anterior (comparativo)...');
  const prev = await coletaJanela(prevStart, weekStart);
  console.error('PRs e snapshot de Review...');
  const prs = await prsCompletados(weekStart, weekEnd);
  const emReviewIds = await wiqlIds(`SELECT [System.Id] FROM WorkItems WHERE ${PJ} AND [System.WorkItemType] IN ('Bug','SI BUG','Product Backlog Item','SI PBI') AND [System.State] = 'Review'`);

  // detalhe dos work items da semana-alvo
  const fcriados = await fields(cur.criados);
  const fresolvidos = await fields(cur.resolvidos);
  const femReview = await fields(emReviewIds);

  const sev = (w) => F(w, 'Microsoft.VSTS.Common.Severity');
  const criticos = fcriados.filter((w) => /1 - Critical/.test(sev(w)));
  const altos = fcriados.filter((w) => /2 - High/.test(sev(w)));
  const autorQA = fcriados.filter((w) => /lucas\.gontijo/i.test(F(w, 'System.CreatedBy')?.uniqueName || '') || /Lucas Gontijo/i.test(F(w, 'System.CreatedBy')?.displayName || ''));
  const homolog = prs.filter((p) => /homolog/i.test(p.title));

  const metrics = {
    janela: { ini: ymd(weekStart), fim: ymd(weekEndDisplay) },
    bugs_criados: { atual: cur.criados.length, anterior: prev.criados.length },
    bugs_resolvidos: { atual: cur.resolvidos.length, anterior: prev.resolvidos.length },
    bugs_producao: { atual: cur.producao.length, anterior: prev.producao.length },
    bugs_reincidentes: { atual: cur.reincidentes.length, anterior: prev.reincidentes.length },
    reprovadas_qa: { atual: cur.reprovadas.length, anterior: prev.reprovadas.length },
    criticos: criticos.length, altos: altos.length,
    qa_criou: { atual: cur.qaCriados.length, anterior: prev.qaCriados.length },
    pct_achados_qa: cur.criados.length ? Math.round((autorQA.length / cur.criados.length) * 100) : 0,
    testes_novos: { atual: cur.testcases.length, anterior: prev.testcases.length },
    prs_concluidos: prs.length, homologacoes: homolog.length,
    taxa_bloqueio_pct: prs.length ? Math.round((cur.reprovadas.length / prs.length) * 100) : 0,
    em_review: emReviewIds.length, em_new: fcriados.filter((w) => F(w, 'System.State') === 'New').length,
    bugs_bloqueados: 'NAO MEDIDO (nao existe estado/metrica de bloqueio nos dados)',
    por_produto_criados: dist(fcriados, 'Custom.Produto'),
    por_produto_resolvidos: dist(fresolvidos, 'Custom.Produto'),
    por_area: dist(fcriados, 'Custom.Area').slice(0, 8),
    por_estado: dist(fcriados, 'System.State'),
    criticos_detalhe: criticos.map((w) => ({ id: w.id, t: F(w, 'System.Title'), estado: F(w, 'System.State'), prod: F(w, 'Custom.Produto'), area: F(w, 'Custom.Area') })),
    review_detalhe: dist(femReview, 'System.WorkItemType'),
    prs_titulos: prs.map((p) => `#${p.id} ${p.title}`).slice(0, 30),
  };

  // ---------- narrativa via Claude ----------
  let narr = null;
  if (flags.claude) {
    console.error(`Gerando narrativa com ${flags.model}...`);
    const prompt = `Voce e o lider de QA do Sittax (SaaS fiscal/contabil) escrevendo o relatorio semanal para a lideranca. Use SOMENTE os numeros abaixo (ja apurados do Azure DevOps). Seja direto, honesto e especifico; cite IDs de bug e produtos. Nao invente metrica que nao esta nos dados.

DADOS DA SEMANA (${metrics.janela.ini} a ${metrics.janela.fim}), com comparativo da semana anterior:
${JSON.stringify(metrics, null, 1)}

REGRAS ANTI-ALUCINACAO (critico):
- Cobertura % por produto NAO e medida (sem instrumentacao de CI) — nao afirme percentual de cobertura; cite "bugs por produto" como proxy.
- NAO invente estados, tags ou categorias que nao estejam nos dados. Os unicos estados existentes sao os de "por_estado"; "em_review" sao itens em Review (NAO chame de "Blocked").
- PROIBIDO citar qualquer numero de bugs "bloqueados"/"Blocked"/"impedidos": essa metrica NAO existe (bugs_bloqueados = NAO MEDIDO). Nao escreva frases como "N bugs em estado Blocked".
- Toda contagem que voce citar deve vir LITERALMENTE de um campo acima. Se for tentado a citar algo que nao esta nos dados, omita.

RESPONDA APENAS com JSON valido:
{
  "resumo_executivo": { "panorama": "2-3 frases", "avancos": ["..."], "riscos": ["..."], "atencao_proxima_semana": ["..."] },
  "achados_positivos": ["2-3 destaques"],
  "achados_negativos": ["2-3 destaques"],
  "proximas_acoes": [ { "acao": "...", "responsavel": "...", "prazo": "DD/MM" } ],
  "precisa_da_engenharia": ["apoios/decisoes/recursos/riscos para a lideranca"],
  "status": "verde|amarelo|vermelho",
  "maior_avanco": "1 frase",
  "maior_risco": "1 frase",
  "prioridade_proxima": "1 frase"
}`;
    try { narr = extractJson(await runClaude(prompt, flags.model)); }
    catch (e) { console.error('Falha na narrativa (seguindo so com numeros):', e.message); }
  }

  // ---------- montar markdown ----------
  const statusIcon = { verde: '🟢 Verde', amarelo: '🟡 Amarelo', vermelho: '🔴 Vermelho' };
  const L = [];
  L.push(`# Relatório Semanal — Qualidade (QA)`);
  L.push(`**Período:** ${dmy(weekStart)} a ${dmy(weekEndDisplay)} de ${weekStart.getUTCFullYear()} · **Fonte:** Azure DevOps · **Gerado:** ${ymd(now)}`);
  L.push('');
  L.push('> Números ✅ vêm de query no Azure DevOps. Cobertura % por produto ⚠️ ainda não é instrumentada (ver CONVENCOES-TAGS.md).');
  L.push('');
  if (narr?.resumo_executivo) {
    const r = narr.resumo_executivo;
    L.push('## 1. Resumo Executivo');
    L.push(`- **Panorama:** ${r.panorama}`);
    if (r.avancos?.length) L.push(`- **Avanços:** ${r.avancos.join('; ')}`);
    if (r.riscos?.length) L.push(`- **Riscos:** ${r.riscos.join('; ')}`);
    if (r.atencao_proxima_semana?.length) L.push(`- **Atenção próxima semana:** ${r.atencao_proxima_semana.join('; ')}`);
    L.push('');
  }
  L.push('## 2. Indicadores de Qualidade');
  L.push('');
  L.push('| Indicador | Semana | vs. anterior |');
  L.push('|---|---|---|');
  L.push(`| Bugs encontrados | ${metrics.bugs_criados.atual} | ${delta(metrics.bugs_criados.atual, metrics.bugs_criados.anterior)} |`);
  L.push(`| Bugs críticos (Sev 1) | ${metrics.criticos} | — |`);
  L.push(`| Bugs alta severidade (Sev 2) | ${metrics.altos} | — |`);
  L.push(`| Bugs corrigidos e validados | ${metrics.bugs_resolvidos.atual} | ${delta(metrics.bugs_resolvidos.atual, metrics.bugs_resolvidos.anterior)} |`);
  L.push(`| Bugs reincidentes (tag \`reincidente\`) | ${metrics.bugs_reincidentes.atual} | ${delta(metrics.bugs_reincidentes.atual, metrics.bugs_reincidentes.anterior)} |`);
  L.push(`| Bugs em produção (tag \`producao\`) | ${metrics.bugs_producao.atual} | ${delta(metrics.bugs_producao.atual, metrics.bugs_producao.anterior)} |`);
  L.push(`| Reprovados pelo QA (tag \`reprovada-sem-teste\`) | ${metrics.reprovadas_qa.atual} | ${delta(metrics.reprovadas_qa.atual, metrics.reprovadas_qa.anterior)} |`);
  L.push('');
  if (metrics.criticos_detalhe.length) {
    L.push('**Bugs críticos:**');
    for (const c of metrics.criticos_detalhe) L.push(`- #${c.id} [${c.estado}] ${c.prod}/${c.area} — ${c.t}`);
    L.push('');
  }
  L.push('## 3. Cobertura e Automação');
  L.push('');
  L.push(`- Novos testes automatizados (Test Case / Teste E2E): **${metrics.testes_novos.atual}** (${delta(metrics.testes_novos.atual, metrics.testes_novos.anterior)})`);
  L.push('- Cobertura % por produto: ⚠️ não instrumentada (ver CONVENCOES-TAGS.md)');
  L.push('');
  L.push('**Bugs por produto (proxy):**');
  L.push('');
  L.push('| Produto | Criados | Validados |');
  L.push('|---|---:|---:|');
  { const res = Object.fromEntries(metrics.por_produto_resolvidos);
    for (const [p, n] of metrics.por_produto_criados) L.push(`| ${p} | ${n} | ${res[p] || 0} |`); }
  L.push('');
  L.push('## 4. Releases e Validações');
  L.push('');
  L.push(`- PRs concluídos: **${metrics.prs_concluidos}** | Homologações: **${metrics.homologacoes}** | Reprovados pelo QA: **${metrics.reprovadas_qa.atual}** | Taxa de bloqueio: ~**${metrics.taxa_bloqueio_pct}%**`);
  L.push('');
  L.push('## 5. Shift Left e Prevenção');
  L.push('');
  L.push(`- Tickets criados pelo QA: **${metrics.qa_criou.atual}** (${delta(metrics.qa_criou.atual, metrics.qa_criou.anterior)})`);
  L.push(`- % dos bugs da semana achados pelo QA: **${metrics.pct_achados_qa}%**`);
  L.push('');
  L.push('## 6. Gargalos e Bloqueios');
  L.push('');
  L.push(`- Em Review (snapshot): **${metrics.em_review}** itens (${metrics.review_detalhe.map(([k, v]) => `${v} ${k}`).join(', ')})`);
  L.push(`- Bugs da semana ainda em New: **${metrics.em_new}**`);
  L.push(`- Áreas com mais bugs: ${metrics.por_area.slice(0, 5).map(([k, v]) => `${k} (${v})`).join(', ')}`);
  L.push('');
  if (narr) {
    L.push('## 7. Principais Achados');
    L.push('');
    L.push('**Positivos**');
    for (const p of narr.achados_positivos || []) L.push(`- ${p}`);
    L.push('');
    L.push('**Negativos**');
    for (const n of narr.achados_negativos || []) L.push(`- ${n}`);
    L.push('');
    if (narr.proximas_acoes?.length) {
      L.push('## 8. Próximas Ações');
      L.push('');
      L.push('| Ação | Responsável | Prazo |');
      L.push('|---|---|---|');
      for (const a of narr.proximas_acoes) L.push(`| ${a.acao} | ${a.responsavel || '—'} | ${a.prazo || '—'} |`);
      L.push('');
    }
    if (narr.precisa_da_engenharia?.length) {
      L.push('## 9. O que o QA precisa da Engenharia?');
      L.push('');
      for (const e of narr.precisa_da_engenharia) L.push(`- ${e}`);
      L.push('');
    }
    L.push('## Resumo Final (1 minuto)');
    L.push('');
    L.push(`**Status da Qualidade:** ${statusIcon[narr.status] || narr.status || '—'}`);
    L.push(`- **Maior avanço:** ${narr.maior_avanco || '—'}`);
    L.push(`- **Maior risco:** ${narr.maior_risco || '—'}`);
    L.push(`- **Prioridade da próxima semana:** ${narr.prioridade_proxima || '—'}`);
    L.push('');
  }
  L.push('---');
  L.push(`_Gerado por relatorio.mjs em ${iso(now)} | janela ${ymd(weekStart)}–${ymd(weekEndDisplay)} (UTC) | modelo: ${flags.claude ? flags.model : '(sem narrativa)'}_`);

  const dir = path.join(ROOT, 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const stem = `Relatorio-QA-${ymd(weekStart)}_a_${ymd(weekEndDisplay)}`;
  fs.writeFileSync(path.join(dir, `${stem}.md`), L.join('\n'), 'utf8');
  fs.writeFileSync(path.join(dir, `${stem}.json`), JSON.stringify({ metrics, narr }, null, 2), 'utf8');
  console.error(`\nRelatorio salvo em reports/${stem}.md`);
  // copia o .md para uma pasta Windows (Area de Trabalho por padrao) — arquivo clicavel, sem caminho \\wsl
  if (flags.copyTo) {
    try {
      fs.mkdirSync(flags.copyTo, { recursive: true });
      fs.copyFileSync(path.join(dir, `${stem}.md`), path.join(flags.copyTo, `${stem}.md`));
      console.error(`Copia na Area de Trabalho: ${flags.copyTo}/${stem}.md`);
    } catch (e) { console.error(`(nao consegui copiar para ${flags.copyTo}: ${e.message})`); }
  }
  console.log(L.join('\n'));
}

main().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
