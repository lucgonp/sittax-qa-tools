#!/usr/bin/env node
// sittax-homologa: homologacao automatica de PRs de leitura de XML (NFSe municipal).
//
// Uso:
//   node homologa.mjs <prId|prUrl> [--model claude-fable-5] [--no-claude]
//                     [--comment]       posta o relatorio no Discussion do work item vinculado ao PR
//                     [--comment-only]  nao roda a analise; posta o reports/pr-<id>.json ja gerado
//
// O que faz:
//   1. Busca o PR no Azure DevOps e identifica os arquivos da branch:
//      - testes (*.cs em /src/Tests) e fixtures XML adicionados/alterados
//      - codigo do leitor alterado (contexto)
//   2. Pede ao Claude uma verificacao INDEPENDENTE: cada valor assertado no teste
//      e conferido contra o XML cru da prefeitura (valores, datas, CNPJs,
//      enderecos, status de cancelamento, contagem de notas no lote).
//   3. Gera relatorio de homologacao em Markdown (stdout + reports/pr-<id>.md).

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

const MAX_XML_CHARS = 80_000;   // por fixture (XML cru e essencial — nao cortar)
const MAX_TEST_CHARS = 60_000;  // por arquivo de teste
const MAX_CODE_CHARS = 15_000;  // por arquivo de codigo (contexto)
// so inclui codigo relacionado a leitura de XML; o resto do diff raramente agrega e dobra o prompt
const CODE_RELEVANTE = /leitor|importacaoxml|nfse|xml/i;

// ---------- args ----------
const argv = process.argv.slice(2);
const flags = { model: 'claude-sonnet-4-6', claude: true, comment: false, commentOnly: false, withCode: false };
let prArg = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--model') flags.model = argv[++i];
  else if (a === '--no-claude') flags.claude = false;
  else if (a === '--comment') flags.comment = true;
  else if (a === '--comment-only') { flags.comment = true; flags.commentOnly = true; }
  else if (a === '--with-code') flags.withCode = true; // inclui todo o codigo do diff, nao so o relacionado a XML
  else prArg = a;
}
if (!prArg) {
  console.error('Uso: node homologa.mjs <prId|prUrl> [--model <m>] [--no-claude]');
  process.exit(2);
}
const m = String(prArg).match(/(\d+)\s*$/);
const PR_ID = m ? m[1] : null;
if (!PR_ID) { console.error(`Nao consegui extrair o numero do PR de: ${prArg}`); process.exit(2); }
const repoMatch = String(prArg).match(/_git\/([0-9a-f-]{36}|[^/]+)\/pullrequest/i);
const REPO = repoMatch ? repoMatch[1] : DEFAULT_REPO;

// ---------- azure devops ----------
let _token = null;
async function token() {
  if (_token) return _token;
  const { stdout } = await execFileP('az', [
    'account', 'get-access-token', '--resource', ADO_RESOURCE, '--query', 'accessToken', '-o', 'tsv',
  ], { maxBuffer: 4 * 1024 * 1024 });
  _token = stdout.trim();
  if (!_token) throw new Error('Token vazio do az. Rode: az login');
  return _token;
}

async function ado(url, asText = false) {
  const t = await token();
  const res = await fetch(url, { headers: { Authorization: `Bearer ${t}` } });
  if (!res.ok) throw new Error(`Azure GET ${res.status}: ${url}\n${(await res.text()).slice(0, 300)}`);
  return asText ? res.text() : res.json();
}

async function adoPost(url, body) {
  const t = await token();
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Azure POST ${res.status}: ${url}\n${(await res.text()).slice(0, 300)}`);
  return res.json();
}

const base = `${ORG}/${encodeURIComponent(PROJECT)}/_apis/git/repositories/${REPO}`;

async function getPr() {
  return ado(`${base}/pullRequests/${PR_ID}?api-version=7.1`);
}

async function getChanges() {
  const iters = await ado(`${base}/pullRequests/${PR_ID}/iterations?api-version=7.1`);
  const last = iters.value[iters.value.length - 1].id;
  const ch = await ado(`${base}/pullRequests/${PR_ID}/iterations/${last}/changes?api-version=7.1&$top=500&$compareTo=0`);
  return (ch.changeEntries || [])
    .filter((c) => c.item && !c.item.isFolder)
    .map((c) => ({ changeType: c.changeType, path: c.item.path }));
}

async function getFile(filePath, branch) {
  const url = `${base}/items?path=${encodeURIComponent(filePath)}&versionDescriptor.version=${encodeURIComponent(branch)}&versionDescriptor.versionType=branch&api-version=7.1&$format=text`;
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
          const env = JSON.parse(out);
          if (env && typeof env.result === 'string') why = env.result.slice(0, 300);
        } catch { if (!why) why = (out || '').trim().slice(0, 300); }
        return reject(new Error(`claude saiu com codigo ${code}: ${why || '(sem saida)'}`));
      }
      try {
        const env = JSON.parse(out);
        resolve(typeof env.result === 'string' ? env.result : out);
      } catch { resolve(out); }
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function clip(s, max) {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n... [TRUNCADO: ${s.length - max} chars omitidos]`;
}

function buildPrompt(pr, files) {
  const sections = [];
  for (const f of files.xmls) sections.push(`### FIXTURE XML: ${f.path}\n\`\`\`xml\n${clip(f.content, MAX_XML_CHARS)}\n\`\`\``);
  for (const f of files.tests) sections.push(`### ARQUIVO DE TESTE: ${f.path}\n\`\`\`csharp\n${clip(f.content, MAX_TEST_CHARS)}\n\`\`\``);
  for (const f of files.code) sections.push(`### CODIGO ALTERADO (contexto): ${f.path}\n\`\`\`csharp\n${clip(f.content, MAX_CODE_CHARS)}\n\`\`\``);

  return `Voce e um analista de QA fiscal fazendo a HOMOLOGACAO de um PR que implementa/ajusta a leitura de XML de NFSe municipal no sistema Sittax.

PR #${PR_ID}: ${pr.title}
Branch: ${pr.sourceRefName}
Descricao: ${pr.description || '(sem descricao)'}

O dev escreveu o parser E os asserts do teste — entao o teste passar nao prova correcao (o dev pode ter copiado a saida do parser para os asserts). Seu trabalho e a verificacao INDEPENDENTE: conferir cada valor assertado no teste contra o XML CRU da prefeitura.

REGRAS DA ANALISE:
1. Para cada nota assertada no teste, localize-a no XML (pelo Numero/ChaveAcesso) e confira campo a campo: numero, serie, datas (emissao, competencia), valores (total, base de calculo, deducoes, descontos), CNPJ/CPF e nome de emitente e destinatario, enderecos, codigo do municipio, codigo do servico, status (100=normal, 101=cancelada), itens (descricao, quantidade, valor unitario, total).
2. CLASSIFICACAO ENTRADA vs SAIDA (critico): no Sittax, a nota aparece na tela de SAIDA para a empresa cujo CNPJ == EmitenteCpfCnpj, e na tela de ENTRADA para a empresa cujo CNPJ == DestinatarioCpfCnpj. Para NFSe, o leitor DEVE mapear PrestadorServico -> Emitente e TomadorServico -> Destinatario. Confira no XML cru que o CNPJ assertado em EmitenteCpfCnpj e realmente o do PRESTADOR e o de DestinatarioCpfCnpj e realmente o do TOMADOR — uma inversao faz a nota aparecer na tela errada (servico prestado viraria nota de entrada). Declare explicitamente no relatorio (campo "classificacao_entrada_saida") como as notas serao apresentadas: para qual CNPJ/empresa cairao em Saida (servico prestado) e para qual em Entrada (servico tomado).
3. Casos de borda da classificacao: tomador sem CpfCnpj ou pessoa fisica (CPF) — a nota nunca aparecera como entrada para ninguem, confira se o XML tem esses casos e se o teste cobre; prestador == tomador (mesmo CNPJ); tomador de outro municipio (ISS pode ser devido em municipio diferente do prestador — confira CodigoDoMunicipioPrestacaoDeServico vs municipio do prestador).
4. Confira a CONTAGEM: quantas notas o lote tem no XML vs quantas o teste espera. Em lotes com cancelamento, verifique se as notas canceladas/substituidas foram tratadas corretamente E que as notas vizinhas nao foram afetadas (Status 100 nas demais).
5. Aponte COBERTURA FALTANTE: notas do lote que o teste NAO confere; campos relevantes sem assert (Aliquota, ValorIss, retencoes, IssRetido->Tributa); cenarios ausentes (ex.: nota cancelada nao testada, lote sem cancelamento nao testado, ISS retido).
6. Datas: o XML usa ISO (2026-04-23T15:29:47); confira conversao exata. Valores: confira casas decimais.
7. ChaveAcesso: verifique que a regra de montagem produz chave UNICA e deterministica para cada nota (duas notas do lote nao podem gerar a mesma chave; reimportar o mesmo XML deve gerar as mesmas chaves — e o que evita duplicidade no sistema).
8. Divergencia entre assert e XML = problema REAL a reportar, mesmo que o teste passe. Diferencas que vierem do XML da prefeitura (ex.: typo no endereco) NAO sao erro do parser — mencione como observacao.
9. Se o codigo do leitor estiver incluido, verifique se a logica de mapeamento condiz (ex.: qual campo vira ChaveAcesso, como monta a chave).
10. Seja cetico e minucioso na CONFERENCIA, mas conciso na ESCRITA: em "conferencias_ok" agrupe ("nota 152: ~30 campos conferem"), nao enumere campo a campo; "observacoes" e "explicacao" em 1-2 frases cada. Divergencias e cobertura faltante podem ser detalhadas.

RESPONDA APENAS com JSON valido neste formato:
{
  "veredito": "aprovado" | "aprovado_com_ressalvas" | "reprovado",
  "resumo": "1-3 frases em pt-BR",
  "classificacao_entrada_saida": {
    "correta": true|false,
    "explicacao": "como as notas serao apresentadas no sistema: para qual CNPJ/empresa aparecem como SAIDA (servico prestado) e para quais como ENTRADA (servico tomado); cite os CNPJs do XML",
    "riscos": [ "casos de borda encontrados (tomador PF, sem CNPJ, prestador==tomador, municipio diferente...)" ]
  },
  "divergencias": [
    { "severidade": "alta|media|baixa", "nota": "numero ou chave", "campo": "...", "esperado_pelo_teste": "...", "valor_no_xml": "...", "explicacao": "..." }
  ],
  "cobertura_faltante": [ { "item": "...", "detalhe": "..." } ],
  "conferencias_ok": [ "lista resumida do que foi conferido e bateu (agrupe, ex.: 'nota 152: todos os 30 campos conferem')" ],
  "observacoes": [ "..." ]
}

${sections.join('\n\n')}`;
}

function extractJson(text) {
  let r = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const start = r.search(/[{[]/);
  if (start > 0) r = r.slice(start);
  const end = Math.max(r.lastIndexOf('}'), r.lastIndexOf(']'));
  if (end >= 0) r = r.slice(0, end + 1);
  return JSON.parse(r);
}

function renderReport(pr, files, rep) {
  const sevIcon = { alta: '🔴', media: '🟠', baixa: '🟡' };
  const verIcon = { aprovado: '✅', aprovado_com_ressalvas: '⚠️', reprovado: '❌' };
  const L = [];
  L.push(`# Homologacao automatica — PR #${PR_ID}`);
  L.push('');
  L.push(`**${pr.title}**`);
  L.push(`- Branch: \`${pr.sourceRefName?.replace('refs/heads/', '')}\` → \`${pr.targetRefName?.replace('refs/heads/', '')}\``);
  L.push(`- Autor: ${pr.createdBy?.displayName || '?'}`);
  L.push(`- Fixtures analisadas: ${files.xmls.map((f) => path.posix.basename(f.path)).join(', ') || '(nenhuma)'}`);
  L.push(`- Testes analisados: ${files.tests.map((f) => path.posix.basename(f.path)).join(', ') || '(nenhum)'}`);
  L.push('');
  L.push(`## Veredito: ${verIcon[rep.veredito] || ''} ${String(rep.veredito || '?').toUpperCase()}`);
  L.push('');
  L.push(rep.resumo || '');
  L.push('');
  if (rep.classificacao_entrada_saida) {
    const c = rep.classificacao_entrada_saida;
    L.push(`## Entrada vs Saída no sistema ${c.correta === false ? '❌ INCORRETA' : '✅'}`);
    L.push('');
    L.push(c.explicacao || '');
    if (c.riscos?.length) {
      L.push('');
      for (const r of c.riscos) L.push(`- ⚠️ ${r}`);
    }
    L.push('');
  }
  if (rep.divergencias?.length) {
    L.push('## Divergencias (assert vs XML)');
    L.push('');
    for (const d of rep.divergencias) {
      L.push(`- ${sevIcon[d.severidade] || ''} **[${d.severidade}] nota ${d.nota} — ${d.campo}**`);
      L.push(`  - teste espera: \`${d.esperado_pelo_teste}\` | XML diz: \`${d.valor_no_xml}\``);
      L.push(`  - ${d.explicacao}`);
    }
    L.push('');
  } else {
    L.push('## Divergencias (assert vs XML)');
    L.push('');
    L.push('Nenhuma — todos os valores assertados conferem com o XML cru.');
    L.push('');
  }
  if (rep.cobertura_faltante?.length) {
    L.push('## Cobertura faltante');
    L.push('');
    for (const c of rep.cobertura_faltante) L.push(`- **${c.item}** — ${c.detalhe}`);
    L.push('');
  }
  if (rep.conferencias_ok?.length) {
    L.push('## Conferido e OK');
    L.push('');
    for (const c of rep.conferencias_ok) L.push(`- ${c}`);
    L.push('');
  }
  if (rep.observacoes?.length) {
    L.push('## Observacoes');
    L.push('');
    for (const o of rep.observacoes) L.push(`- ${o}`);
    L.push('');
  }
  L.push('---');
  L.push(`_Gerado por sittax-homologa em ${new Date().toISOString()} | modelo: ${flags.model}_`);
  return L.join('\n');
}

// ---------- discussion (work item) ----------
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function renderHtml(pr, rep) {
  const verLabel = { aprovado: '✅ APROVADO', aprovado_com_ressalvas: '⚠️ APROVADO COM RESSALVAS', reprovado: '❌ REPROVADO' };
  const sevIcon = { alta: '🔴', media: '🟠', baixa: '🟡' };
  const prUrl = `${ORG}/${encodeURIComponent(PROJECT)}/_git/${REPO}/pullrequest/${PR_ID}`;
  const H = [];
  H.push(`<p><b>Homologação automática — <a href="${prUrl}">PR #${PR_ID}</a></b>: ${esc(pr.title)}</p>`);
  H.push(`<p><b>Veredito: ${verLabel[rep.veredito] || esc(rep.veredito)}</b></p>`);
  if (rep.resumo) H.push(`<p>${esc(rep.resumo)}</p>`);
  if (rep.classificacao_entrada_saida) {
    const c = rep.classificacao_entrada_saida;
    H.push(`<p><b>Entrada vs Saída no sistema ${c.correta === false ? '❌ INCORRETA' : '✅'}:</b> ${esc(c.explicacao)}</p>`);
    if (c.riscos?.length) {
      H.push('<ul>');
      for (const r of c.riscos) H.push(`<li>⚠️ ${esc(r)}</li>`);
      H.push('</ul>');
    }
  }
  if (rep.divergencias?.length) {
    H.push('<p><b>Divergências (assert vs XML):</b></p><ul>');
    for (const d of rep.divergencias) {
      H.push(`<li>${sevIcon[d.severidade] || ''} <b>[${esc(d.severidade)}] nota ${esc(d.nota)} — ${esc(d.campo)}</b>: teste espera <code>${esc(d.esperado_pelo_teste)}</code>, XML diz <code>${esc(d.valor_no_xml)}</code>. ${esc(d.explicacao)}</li>`);
    }
    H.push('</ul>');
  } else {
    H.push('<p><b>Divergências:</b> nenhuma — todos os valores assertados conferem com o XML cru.</p>');
  }
  if (rep.cobertura_faltante?.length) {
    H.push('<p><b>Cobertura faltante:</b></p><ul>');
    for (const c of rep.cobertura_faltante) H.push(`<li><b>${esc(c.item)}</b> — ${esc(c.detalhe)}</li>`);
    H.push('</ul>');
  }
  if (rep.conferencias_ok?.length) {
    H.push('<p><b>Conferido e OK:</b></p><ul>');
    for (const c of rep.conferencias_ok) H.push(`<li>${esc(c)}</li>`);
    H.push('</ul>');
  }
  if (rep.observacoes?.length) {
    H.push('<p><b>Observações:</b></p><ul>');
    for (const o of rep.observacoes) H.push(`<li>${esc(o)}</li>`);
    H.push('</ul>');
  }
  H.push(`<p><i>Gerado por sittax-homologa (modelo: ${esc(flags.model)})</i></p>`);
  return H.join('');
}

async function linkedWorkItems(pr) {
  try {
    const r = await ado(`${base}/pullRequests/${PR_ID}/workitems?api-version=7.1`);
    const ids = (r.value || []).map((w) => w.id);
    if (ids.length) return ids;
  } catch { /* cai no fallback */ }
  // fallback: #NNNNN no titulo/descricao do PR ou na branch
  const txt = `${pr.title} ${pr.description || ''} ${pr.sourceRefName}`;
  const ms = [...txt.matchAll(/#(\d{3,7})/g), ...txt.matchAll(/\/(\d{3,7})-/g)];
  return [...new Set(ms.map((x) => x[1]))];
}

async function postDiscussion(pr, rep) {
  const ids = await linkedWorkItems(pr);
  if (!ids.length) {
    log('AVISO: nenhum work item vinculado ao PR (nem #NNNNN no titulo) — comentario nao postado.');
    return;
  }
  const html = renderHtml(pr, rep);
  for (const id of ids) {
    const url = `${ORG}/${encodeURIComponent(PROJECT)}/_apis/wit/workItems/${id}/comments?api-version=7.1-preview.3`;
    await adoPost(url, { text: html });
    log(`Comentario postado no Discussion do work item #${id}: ${ORG}/${encodeURIComponent(PROJECT)}/_workitems/edit/${id}`);
  }
}

// ---------- main ----------
const log = (s) => console.error(s); // progresso no stderr; relatorio no stdout

const pr = await getPr();
const branch = pr.sourceRefName.replace('refs/heads/', '');
log(`PR #${PR_ID}: ${pr.title}`);
log(`Branch: ${branch} (status: ${pr.status})`);

if (flags.commentOnly) {
  const jsonPath = path.join(ROOT, 'reports', `pr-${PR_ID}.json`);
  if (!fs.existsSync(jsonPath)) {
    log(`ERRO: ${jsonPath} nao existe. Rode antes: node homologa.mjs ${PR_ID}`);
    process.exit(1);
  }
  const rep = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  await postDiscussion(pr, rep);
  process.exit(0);
}

const changes = await getChanges();
const isTest = (p) => /\/src\/Tests\//i.test(p);
const testCs = changes.filter((c) => isTest(c.path) && c.path.endsWith('.cs') && c.changeType !== 'delete');
const xmls = changes.filter((c) => isTest(c.path) && /\.xml$/i.test(c.path) && c.changeType !== 'delete');
const code = changes.filter((c) => !isTest(c.path) && c.path.endsWith('.cs') && c.changeType !== 'delete');

log(`Arquivos: ${testCs.length} teste(s), ${xmls.length} fixture(s) XML, ${code.length} arquivo(s) de codigo`);
if (!xmls.length || !testCs.length) {
  log('AVISO: PR sem fixtures XML ou sem testes em /src/Tests — talvez nao seja um PR de homologacao de leitura de XML.');
}

async function fetchAll(list) {
  const out = [];
  for (const c of list) {
    log(`  baixando ${c.path}`);
    out.push({ path: c.path, content: await getFile(c.path, branch) });
  }
  return out;
}

const codeRelevante = flags.withCode ? code : code.filter((c) => CODE_RELEVANTE.test(c.path));
if (code.length && !codeRelevante.length) log(`Codigo do diff ignorado (${code.length} arquivo(s) sem relacao com leitura de XML — use --with-code para incluir).`);
const files = {
  tests: await fetchAll(testCs),
  xmls: await fetchAll(xmls),
  code: await fetchAll(codeRelevante.slice(0, 3)),
};

const prompt = buildPrompt(pr, files);
log(`Prompt: ${(prompt.length / 1000).toFixed(0)}k chars`);

if (!flags.claude) {
  console.log(prompt);
  process.exit(0);
}

log(`Analisando com ${flags.model} (pode levar alguns minutos)...`);
const raw = await runClaude(prompt, flags.model);
let rep;
try { rep = extractJson(raw); } catch (e) {
  log(`ERRO ao parsear resposta do Claude: ${e.message}`);
  console.log(raw);
  process.exit(1);
}

const report = renderReport(pr, files, rep);
const dir = path.join(ROOT, 'reports');
fs.mkdirSync(dir, { recursive: true });
const outPath = path.join(dir, `pr-${PR_ID}.md`);
fs.writeFileSync(outPath, report, 'utf8');
fs.writeFileSync(path.join(dir, `pr-${PR_ID}.json`), JSON.stringify(rep, null, 2), 'utf8');
log(`\nRelatorio salvo em ${outPath}\n`);
console.log(report);

if (flags.comment) await postDiscussion(pr, rep);
