#!/usr/bin/env node
// sittax-homologa PARTE 2: importacao real no ambiente de staging.
//
// Fluxo:
//   1. Baixa do PR os testes e fixtures XML (igual ao homologa.mjs).
//   2. Claude extrai do teste as notas ESPERADAS (chaveAcesso + campos assertados).
//   3. Em stage: remove as chaves (limpeza idempotente), importa cada XML via
//      api/upload/importar-arquivo (autenticado; processa assincrono via fila),
//      e consulta cada chave em obter-nota-fiscal-entrada / obter-nota-fiscal-saida
//      com polling ate a nota aparecer.
//   4. Claude compara o que o SISTEMA gravou vs o que o teste espera.
//   5. Relatorio em reports/pr-<id>-stage.md/.json; --comment posta no Discussion.
//
// Uso:
//   node stage.mjs <prId|prUrl> [--comment] [--dry-run] [--no-cleanup]
//                  [--model claude-sonnet-4-6] [--comment-only]
//
// IMPORTANTE: o stage roda o codigo DEPLOYADO, nao a branch do PR. Rode a parte 2
// depois que o PR foi completado e o deploy de stage subiu (atividade em Review).
// Credenciais: .env com STAGE_USER/STAGE_PASS (default: usuario sistema de QA).

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
const DEFAULT_REPO = '12432724-c815-4561-b014-9f584316f53a'; // Sittax

const STAGE_API = 'https://api.stage.sittax.com.br';
const STAGE_AUTH = 'https://autenticacao.stage.sittax.com.br/api/auth/login';
const STAGE_ORIGIN = 'https://homologacao.sittax.com.br'; // libera o DynamicAllowAnonymousFilter do upload-homologacao
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:151.0) Gecko/20100101 Firefox/151.0'; // Cloudflare exige UA de browser

const MAX_TEST_CHARS = 60_000;
const POLL_TENTATIVAS = 12;       // upload e assincrono (fila RabbitMQ) — espera ate ~1min por chave
const POLL_INTERVALO_MS = 5_000;

// ---------- .env ----------
const env = {};
const envPath = path.join(ROOT, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const STAGE_USER = env.STAGE_USER || 'sistema@sittax.com.br';
const STAGE_PASS = env.STAGE_PASS || 'senhas';

// ---------- args ----------
const argv = process.argv.slice(2);
const flags = { model: 'claude-sonnet-4-6', comment: false, commentOnly: false, dryRun: false, cleanup: true };
let prArg = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--model') flags.model = argv[++i];
  else if (a === '--comment') flags.comment = true;
  else if (a === '--comment-only') { flags.comment = true; flags.commentOnly = true; }
  else if (a === '--dry-run') flags.dryRun = true;
  else if (a === '--no-cleanup') flags.cleanup = false;
  else prArg = a;
}
if (!prArg) {
  console.error('Uso: node stage.mjs <prId|prUrl> [--comment] [--dry-run] [--no-cleanup] [--model <m>]');
  process.exit(2);
}
const m = String(prArg).match(/(\d+)\s*$/);
const PR_ID = m ? m[1] : null;
if (!PR_ID) { console.error(`Nao consegui extrair o numero do PR de: ${prArg}`); process.exit(2); }
const repoMatch = String(prArg).match(/_git\/([0-9a-f-]{36}|[^/]+)\/pullrequest/i);
const REPO = repoMatch ? repoMatch[1] : DEFAULT_REPO;

const log = (s) => console.error(s);

// ---------- azure devops ----------
let _adoToken = null;
async function adoToken() {
  if (_adoToken) return _adoToken;
  const { stdout } = await execFileP('az', [
    'account', 'get-access-token', '--resource', ADO_RESOURCE, '--query', 'accessToken', '-o', 'tsv',
  ], { maxBuffer: 4 * 1024 * 1024 });
  _adoToken = stdout.trim();
  if (!_adoToken) throw new Error('Token vazio do az. Rode: az login');
  return _adoToken;
}

async function ado(url, asText = false) {
  const t = await adoToken();
  const res = await fetch(url, { headers: { Authorization: `Bearer ${t}` } });
  if (!res.ok) throw new Error(`Azure GET ${res.status}: ${url}\n${(await res.text()).slice(0, 300)}`);
  return asText ? res.text() : res.json();
}

async function adoPost(url, body) {
  const t = await adoToken();
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Azure POST ${res.status}: ${url}\n${(await res.text()).slice(0, 300)}`);
  return res.json();
}

const base = `${ORG}/${encodeURIComponent(PROJECT)}/_apis/git/repositories/${REPO}`;

async function getChanges() {
  const iters = await ado(`${base}/pullRequests/${PR_ID}/iterations?api-version=7.1`);
  const last = iters.value[iters.value.length - 1].id;
  const ch = await ado(`${base}/pullRequests/${PR_ID}/iterations/${last}/changes?api-version=7.1&$top=500&$compareTo=0`);
  return (ch.changeEntries || [])
    .filter((c) => c.item && !c.item.isFolder)
    .map((c) => ({ changeType: c.changeType, path: c.item.path }));
}

async function getFile(filePath, ver) {
  const url = `${base}/items?path=${encodeURIComponent(filePath)}&versionDescriptor.version=${encodeURIComponent(ver.value)}&versionDescriptor.versionType=${ver.type}&api-version=7.1&$format=text`;
  return ado(url, true);
}

// ---------- claude ----------
function runClaude(prompt, model) {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['-p', '--output-format', 'json', '--model', model], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => reject(new Error(`Nao consegui executar "claude": ${e.message}`)));
    child.on('close', (code) => {
      if (code !== 0) {
        let why = (err || '').trim();
        try {
          const envl = JSON.parse(out);
          if (envl && typeof envl.result === 'string') why = envl.result.slice(0, 300);
        } catch { if (!why) why = (out || '').trim().slice(0, 300); }
        return reject(new Error(`claude saiu com codigo ${code}: ${why || '(sem saida)'}`));
      }
      try {
        const envl = JSON.parse(out);
        resolve(typeof envl.result === 'string' ? envl.result : out);
      } catch { resolve(out); }
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function extractJson(text) {
  let r = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const start = r.search(/[{[]/);
  if (start > 0) r = r.slice(start);
  const end = Math.max(r.lastIndexOf('}'), r.lastIndexOf(']'));
  if (end >= 0) r = r.slice(0, end + 1);
  return JSON.parse(r);
}

const clip = (s, max) => (s.length <= max ? s : s.slice(0, max) + `\n... [TRUNCADO]`);

// ---------- stage client ----------
const stageHeaders = (extra = {}) => ({
  'User-Agent': UA, Origin: STAGE_ORIGIN, Referer: STAGE_ORIGIN + '/', ...extra,
});

let _stageToken = null;
async function stageLogin() {
  if (_stageToken) return _stageToken;
  const res = await fetch(STAGE_AUTH, {
    method: 'POST',
    headers: stageHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ usuario: STAGE_USER, senha: STAGE_PASS }),
  });
  if (!res.ok) throw new Error(`Login em stage falhou (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  if (!body.token) throw new Error(`Login em stage sem token: ${JSON.stringify(body).slice(0, 200)}`);
  log(`Login em stage OK (usuario: ${body.usuario?.nome || STAGE_USER})`);
  _stageToken = body.token;
  return _stageToken;
}

async function stageGet(pathname, extraHeaders = {}) {
  const t = await stageLogin();
  const res = await fetch(`${STAGE_API}${pathname}`, {
    headers: stageHeaders({ Authorization: `Bearer ${t}`, ...extraHeaders }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Stage GET ${res.status} ${pathname}: ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { return text; }
}

async function stagePost(pathname, body, extraHeaders = {}) {
  const t = await stageLogin();
  const res = await fetch(`${STAGE_API}${pathname}`, {
    method: 'POST',
    headers: stageHeaders({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json', ...extraHeaders }),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Stage POST ${res.status} ${pathname}: ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { return text; }
}

// api/upload-homologacao (sincrono, anonimo) NAO esta exposto no host api.stage (404)
// — usa o endpoint autenticado api/upload/importar-arquivo, que publica na fila
// RabbitMQ e processa assincrono; a consulta posterior faz polling ate a nota aparecer.
async function stageUploadXml(fileName, content) {
  const t = await stageLogin();
  const fd = new FormData();
  fd.append('arquivo', new Blob([content], { type: 'text/xml' }), fileName);
  const res = await fetch(`${STAGE_API}/api/upload/importar-arquivo`, {
    method: 'POST', headers: stageHeaders({ Authorization: `Bearer ${t}` }), body: fd,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Upload ${res.status}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return { sucesso: false, mensagem: text.slice(0, 300) }; }
}

async function removerNotas(chaves, cnpj) {
  return stagePost('/api/nota-fiscal/remover-notas-fiscais-por-chaves', {
    chavesAcesso: chaves,
    cnpj: { numero: cnpj },
    motivo: `Homologacao automatica do PR #${PR_ID} (sittax-homologa stage.mjs)`,
  });
}

async function consultarNota(chave, emitenteCnpj) {
  const out = { chaveAcesso: chave, encontrada: false, telas: [], entrada: null, saida: null };
  try {
    const e = await stageGet(`/api/nota-fiscal/obter-nota-fiscal-entrada?chaveAcesso=${encodeURIComponent(chave)}`);
    if (e?.nota) { out.encontrada = true; out.telas.push('entrada'); out.entrada = e.nota; }
  } catch (err) { out.entrada = { erro: err.message }; }
  try {
    // CnpjDaEmpresaSelecionada pode ir por header (BaseController: cookie ?? header)
    const s = await stageGet(`/api/nota-fiscal/obter-nota-fiscal-saida?chaveAcesso=${encodeURIComponent(chave)}`,
      emitenteCnpj ? { CnpjDaEmpresaSelecionada: emitenteCnpj } : {});
    if (s?.nota) { out.encontrada = true; out.telas.push('saida'); out.saida = s.nota; }
  } catch (err) { out.saida = { erro: err.message }; }
  return out;
}

// ---------- prompts ----------
function promptExtrair(tests) {
  const sections = tests.map((f) => `### ARQUIVO DE TESTE: ${f.path}\n\`\`\`csharp\n${clip(f.content, MAX_TEST_CHARS)}\n\`\`\``);
  return `Extraia dos testes unitarios abaixo as notas fiscais ESPERADAS apos a importacao do XML de NFSe.

Para cada nota assertada no teste, retorne a chave de acesso EXATA esperada e os campos assertados.
Se a chave for montada dinamicamente no teste, calcule o valor final (os insumos estao no proprio teste/XML).
Inclua apenas campos que o teste de fato asserta.

RESPONDA APENAS com JSON valido:
{
  "notas_esperadas": [
    {
      "chaveAcesso": "chave exata esperada",
      "emitenteCpfCnpj": "cnpj do prestador (so digitos)",
      "esperado": { "numero": "...", "destinatarioCpfCnpj": "...", "valorTotal": 0, "dataEmissao": "...", "status": 0, "outros_campos_assertados": "..." }
    }
  ]
}

${sections.join('\n\n')}`;
}

function promptComparar(esperadas, consultas, uploads) {
  return `Voce e um analista de QA conferindo a PARTE 2 da homologacao de leitura de XML NFSe do Sittax: o XML foi importado de verdade no ambiente de STAGING e as notas foram consultadas via API. Compare o que o SISTEMA gravou contra o que o TESTE UNITARIO espera.

CONTEXTO:
- Resultado dos uploads (a mensagem indica a quantidade importada): ${JSON.stringify(uploads)}
- A nota deve aparecer na tela de SAIDA para a empresa do CNPJ == emitente (prestador) e em ENTRADA para o destinatario (tomador). Nota nao encontrada em lugar nenhum = problema grave (parser nao gerou a nota, chave divergente, ou empresa nao cadastrada em stage — diferencie pelo contexto).
- Os nomes dos campos no JSON do sistema podem diferir dos do teste (ex.: valorTotal vs ValorTotal vs valorServicos) — compare semanticamente.
- Enums do teste podem ser persistidos como codigo numerico (ex.: ModeloNota.NFSE -> "99" [codigo ABRASF de NFSe], TipoCidadesUtil.X.GetHashCode() -> codigo IBGE). Valor numerico equivalente ao enum NAO e divergencia — trate como conferido; se nao puder confirmar o mapeamento, registre como observacao de severidade baixa, nunca alta.

NOTAS ESPERADAS (extraidas do teste):
${JSON.stringify(esperadas, null, 1)}

NOTAS NO SISTEMA (consultadas em stage apos a importacao):
${JSON.stringify(consultas, null, 1)}

RESPONDA APENAS com JSON valido:
{
  "veredito": "aprovado" | "aprovado_com_ressalvas" | "reprovado",
  "resumo": "1-3 frases em pt-BR",
  "notas": [
    {
      "chaveAcesso": "...",
      "encontrada": true|false,
      "telas": ["entrada","saida"],
      "divergencias": [ { "severidade": "alta|media|baixa", "campo": "...", "esperado": "...", "no_sistema": "...", "explicacao": "..." } ],
      "ok": [ "resumo agrupado do que conferiu" ]
    }
  ],
  "observacoes": [ "ex.: empresa possivelmente nao cadastrada em stage; upload retornou qtd diferente do esperado" ]
}`;
}

// ---------- render ----------
const verIcon = { aprovado: '✅', aprovado_com_ressalvas: '⚠️', reprovado: '❌' };
const sevIcon = { alta: '🔴', media: '🟠', baixa: '🟡' };

function renderMd(pr, rep, uploads, avisos) {
  const L = [];
  L.push(`# Homologacao parte 2 (importacao em staging) — PR #${PR_ID}`);
  L.push('');
  L.push(`**${pr.title}**`);
  L.push(`- PR: ${pr.status === 'completed' ? 'completado' : `**${pr.status}** (atencao: stage roda o codigo deployado, nao a branch do PR)`}`);
  for (const a of avisos) L.push(`- ⚠️ ${a}`);
  L.push('');
  L.push(`## Veredito: ${verIcon[rep.veredito] || ''} ${String(rep.veredito || '?').toUpperCase()}`);
  L.push('');
  L.push(rep.resumo || '');
  L.push('');
  L.push('## Uploads');
  L.push('');
  for (const u of uploads) L.push(`- \`${u.arquivo}\` → ${u.sucesso ? '✅' : '❌'} ${u.mensagem}`);
  L.push('');
  L.push('## Notas conferidas no sistema');
  L.push('');
  for (const n of rep.notas || []) {
    L.push(`### ${n.encontrada ? '✅' : '❌'} ${n.chaveAcesso} ${n.encontrada ? `(telas: ${n.telas?.join(', ') || '?'})` : '(NAO ENCONTRADA)'}`);
    for (const d of n.divergencias || []) {
      L.push(`- ${sevIcon[d.severidade] || ''} **[${d.severidade}] ${d.campo}**: teste espera \`${d.esperado}\` | sistema gravou \`${d.no_sistema}\` — ${d.explicacao}`);
    }
    for (const ok of n.ok || []) L.push(`- ${ok}`);
    L.push('');
  }
  if (rep.observacoes?.length) {
    L.push('## Observacoes');
    L.push('');
    for (const o of rep.observacoes) L.push(`- ${o}`);
    L.push('');
  }
  L.push('---');
  L.push(`_Gerado por sittax-homologa stage.mjs em ${new Date().toISOString()} | modelo: ${flags.model} | ambiente: ${STAGE_API}_`);
  return L.join('\n');
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function renderHtml(pr, rep, uploads, avisos) {
  const verLabel = { aprovado: '✅ APROVADO', aprovado_com_ressalvas: '⚠️ APROVADO COM RESSALVAS', reprovado: '❌ REPROVADO' };
  const prUrl = `${ORG}/${encodeURIComponent(PROJECT)}/_git/${REPO}/pullrequest/${PR_ID}`;
  const H = [];
  H.push(`<p><b>Homologação parte 2 — importação em staging — <a href="${prUrl}">PR #${PR_ID}</a></b>: ${esc(pr.title)}</p>`);
  H.push(`<p><b>Veredito: ${verLabel[rep.veredito] || esc(rep.veredito)}</b></p>`);
  if (rep.resumo) H.push(`<p>${esc(rep.resumo)}</p>`);
  for (const a of avisos) H.push(`<p>⚠️ ${esc(a)}</p>`);
  H.push('<p><b>Uploads:</b></p><ul>');
  for (const u of uploads) H.push(`<li>${u.sucesso ? '✅' : '❌'} <code>${esc(u.arquivo)}</code> — ${esc(u.mensagem)}</li>`);
  H.push('</ul>');
  H.push('<p><b>Notas conferidas no sistema (stage):</b></p><ul>');
  for (const n of rep.notas || []) {
    const div = (n.divergencias || []).map((d) => `<br>${sevIcon[d.severidade] || ''} [${esc(d.severidade)}] <b>${esc(d.campo)}</b>: teste espera <code>${esc(d.esperado)}</code>, sistema gravou <code>${esc(d.no_sistema)}</code> — ${esc(d.explicacao)}`).join('');
    const ok = (n.ok || []).map((o) => `<br>· ${esc(o)}`).join('');
    H.push(`<li>${n.encontrada ? '✅' : '❌'} <code>${esc(n.chaveAcesso)}</code> ${n.encontrada ? `(telas: ${esc(n.telas?.join(', ') || '?')})` : '<b>NÃO ENCONTRADA</b>'}${div}${ok}</li>`);
  }
  H.push('</ul>');
  if (rep.observacoes?.length) {
    H.push('<p><b>Observações:</b></p><ul>');
    for (const o of rep.observacoes) H.push(`<li>${esc(o)}</li>`);
    H.push('</ul>');
  }
  H.push(`<p><i>Gerado por sittax-homologa stage.mjs (modelo: ${esc(flags.model)})</i></p>`);
  return H.join('');
}

async function linkedWorkItems(pr) {
  try {
    const r = await ado(`${base}/pullRequests/${PR_ID}/workitems?api-version=7.1`);
    const ids = (r.value || []).map((w) => w.id);
    if (ids.length) return ids;
  } catch { /* fallback */ }
  const txt = `${pr.title} ${pr.description || ''} ${pr.sourceRefName}`;
  const ms = [...txt.matchAll(/#(\d{3,7})/g), ...txt.matchAll(/\/(\d{3,7})-/g)];
  return [...new Set(ms.map((x) => x[1]))];
}

async function postDiscussion(pr, html) {
  const ids = await linkedWorkItems(pr);
  if (!ids.length) { log('AVISO: nenhum work item vinculado ao PR — comentario nao postado.'); return; }
  for (const id of ids) {
    await adoPost(`${ORG}/${encodeURIComponent(PROJECT)}/_apis/wit/workItems/${id}/comments?api-version=7.1-preview.3`, { text: html });
    log(`Comentario postado no work item #${id}: ${ORG}/${encodeURIComponent(PROJECT)}/_workitems/edit/${id}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- main ----------
const pr = await ado(`${base}/pullRequests/${PR_ID}?api-version=7.1`);
const branch = pr.sourceRefName.replace('refs/heads/', '');
// PR completado tem a branch apagada — busca os arquivos pelo commit de merge
const ver = pr.status === 'completed' && pr.lastMergeSourceCommit?.commitId
  ? { type: 'commit', value: pr.lastMergeSourceCommit.commitId }
  : { type: 'branch', value: branch };
log(`PR #${PR_ID}: ${pr.title} (status: ${pr.status}, versao: ${ver.type} ${ver.value})`);

const dir = path.join(ROOT, 'reports');
fs.mkdirSync(dir, { recursive: true });
const jsonPath = path.join(dir, `pr-${PR_ID}-stage.json`);

if (flags.commentOnly) {
  if (!fs.existsSync(jsonPath)) { log(`ERRO: ${jsonPath} nao existe. Rode antes: node stage.mjs ${PR_ID}`); process.exit(1); }
  const saved = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  await postDiscussion(pr, renderHtml(pr, saved.relatorio, saved.uploads, saved.avisos));
  process.exit(0);
}

const avisos = [];
if (pr.status !== 'completed') avisos.push(`PR ainda esta "${pr.status}" — o stage roda o codigo deployado; se o leitor deste PR ainda nao subiu, as notas nao serao geradas/corretas.`);

const changes = await getChanges();
const isTest = (p) => /\/src\/Tests\//i.test(p);
const testCs = changes.filter((c) => isTest(c.path) && c.path.endsWith('.cs') && c.changeType !== 'delete');
const xmls = changes.filter((c) => isTest(c.path) && /\.xml$/i.test(c.path) && c.changeType !== 'delete');
log(`Arquivos do PR: ${testCs.length} teste(s), ${xmls.length} fixture(s) XML`);
if (!xmls.length || !testCs.length) { log('ERRO: PR sem fixtures XML ou sem testes — nada para importar.'); process.exit(1); }

const tests = [];
for (const c of testCs) { log(`  baixando ${c.path}`); tests.push({ path: c.path, content: await getFile(c.path, ver) }); }
const fixtures = [];
for (const c of xmls) { log(`  baixando ${c.path}`); fixtures.push({ path: c.path, name: path.posix.basename(c.path), content: await getFile(c.path, ver) }); }

// 1. extrair notas esperadas do teste
log(`Extraindo notas esperadas do teste com ${flags.model}...`);
const esperadas = extractJson(await runClaude(promptExtrair(tests), flags.model)).notas_esperadas || [];
log(`Notas esperadas: ${esperadas.length} (${esperadas.map((n) => n.chaveAcesso).join(', ')})`);
if (!esperadas.length) { log('ERRO: nao consegui extrair nenhuma chave esperada do teste.'); process.exit(1); }

// 2. limpeza (idempotencia: reimportar nao pode duplicar nem falhar)
const porCnpj = new Map();
for (const n of esperadas) {
  const cnpj = String(n.emitenteCpfCnpj || '').replace(/\D/g, '');
  if (!porCnpj.has(cnpj)) porCnpj.set(cnpj, []);
  porCnpj.get(cnpj).push(n.chaveAcesso);
}
if (flags.dryRun) {
  log('[dry-run] pulando limpeza e upload.');
} else if (flags.cleanup) {
  for (const [cnpj, chaves] of porCnpj) {
    log(`Removendo ${chaves.length} chave(s) previa(s) da empresa ${cnpj}...`);
    try { await removerNotas(chaves, cnpj); } catch (e) { log(`  (remocao falhou — seguindo: ${e.message})`); }
  }
}

// 3. upload
const uploads = [];
if (!flags.dryRun) {
  for (const f of fixtures) {
    log(`Importando ${f.name} em ${STAGE_API}...`);
    try {
      const r = await stageUploadXml(f.name, f.content);
      uploads.push({ arquivo: f.name, sucesso: !!r.sucesso, mensagem: r.mensagem || JSON.stringify(r).slice(0, 200) });
      log(`  → ${r.sucesso ? 'OK' : 'FALHA'}: ${r.mensagem}`);
    } catch (e) {
      uploads.push({ arquivo: f.name, sucesso: false, mensagem: e.message });
      log(`  → ERRO: ${e.message}`);
    }
  }
} else {
  for (const f of fixtures) uploads.push({ arquivo: f.name, sucesso: true, mensagem: '[dry-run] upload pulado' });
}

// 4. consultar cada chave (com retry: gravacao pode ter cauda assincrona)
const consultas = [];
for (const n of esperadas) {
  const cnpj = String(n.emitenteCpfCnpj || '').replace(/\D/g, '');
  let c = null;
  for (let t = 1; t <= POLL_TENTATIVAS; t++) {
    c = await consultarNota(n.chaveAcesso, cnpj);
    if (c.encontrada || flags.dryRun) break;
    log(`  chave ${n.chaveAcesso} ainda nao encontrada (tentativa ${t}/${POLL_TENTATIVAS})...`);
    await sleep(POLL_INTERVALO_MS);
  }
  log(`Consulta ${n.chaveAcesso}: ${c.encontrada ? `encontrada (${c.telas.join(', ')})` : 'NAO encontrada'}`);
  consultas.push(c);
}

// 5. comparacao final
log(`Comparando sistema vs teste com ${flags.model}...`);
const rep = extractJson(await runClaude(promptComparar(esperadas, consultas, uploads), flags.model));

const md = renderMd(pr, rep, uploads, avisos);
fs.writeFileSync(path.join(dir, `pr-${PR_ID}-stage.md`), md, 'utf8');
fs.writeFileSync(jsonPath, JSON.stringify({ relatorio: rep, uploads, avisos, esperadas, consultas }, null, 2), 'utf8');
log(`\nRelatorio salvo em reports/pr-${PR_ID}-stage.md\n`);
console.log(md);

if (flags.comment) await postDiscussion(pr, renderHtml(pr, rep, uploads, avisos));
