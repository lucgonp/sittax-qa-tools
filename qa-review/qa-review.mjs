#!/usr/bin/env node
// sittax-qa-review: gera roteiro de QA para atividades em Review no Azure DevOps.
//
// Uso:
//   node qa-review.mjs --queue                 analisa todas as atividades em estado "Review"
//   node qa-review.mjs 24156 21219             analisa atividades especificas
//   Flags: --no-comment (nao posta no Discussion), --model <m>, --state <nome do estado>
//
// Para cada atividade: baixa work item (descricao, repro steps, criterios de aceite),
// PRs vinculados (diff, arquivos alterados, se inclui testes), e pede ao Claude um
// roteiro de QA: passos de teste, se precisa validacao manual, se precisa teste
// automatizado. Posta como comentario no Discussion e salva em reports/.

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
const ROOT = path.dirname(fileURLToPath(import.meta.url));

const ORG = 'https://dev.azure.com/Sittax';
const PROJECT = 'Sittax';
const ADO_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798';

const MAX_FILES_PER_PR = 8;
const MAX_DIFF_CHARS = 6_000;   // por arquivo (diff, nao arquivo inteiro)
const MAX_FILE_CHARS = 7_000;   // arquivos novos (sem base para diff)

// ---------- args ----------
const argv = process.argv.slice(2);
const flags = { model: 'claude-sonnet-4-6', comment: true, queue: false, state: 'Review', newOnly: false, autoReject: false };
const ids = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--model') flags.model = argv[++i];
  else if (a === '--no-comment') flags.comment = false;
  else if (a === '--queue') flags.queue = true;
  else if (a === '--state') flags.state = argv[++i];
  else if (a === '--new-only') flags.newOnly = true;
  else if (a === '--auto-reject') flags.autoReject = true;
  else if (/^\d+$/.test(a)) ids.push(a);
}
if (!flags.queue && !ids.length) {
  console.error('Uso: node qa-review.mjs --queue | <id...> [--no-comment] [--model m]');
  process.exit(2);
}

const log = (s) => console.error(s);

// ---------- azure ----------
let _token = null;
async function token() {
  if (_token) return _token;
  // em pipeline: ADO_TOKEN=$(System.AccessToken); local: az login
  const envTok = process.env.ADO_TOKEN || process.env.SYSTEM_ACCESSTOKEN;
  if (envTok) return (_token = envTok.trim());
  const { stdout } = await execFileP('az', [
    'account', 'get-access-token', '--resource', ADO_RESOURCE, '--query', 'accessToken', '-o', 'tsv',
  ], { maxBuffer: 4 * 1024 * 1024 });
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
  if (!res.ok) throw new Error(`Azure ${opts.method || 'GET'} ${res.status}: ${url}\n${(await res.text()).slice(0, 300)}`);
  return opts.asText ? res.text() : res.json();
}

const proj = encodeURIComponent(PROJECT);

async function queueIds() {
  const r = await ado(`${ORG}/${proj}/_apis/wit/wiql?api-version=7.1`, {
    method: 'POST',
    body: { query: `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '${PROJECT}' AND [System.State] = '${flags.state}' ORDER BY [System.ChangedDate] DESC` },
  });
  return (r.workItems || []).map((w) => String(w.id));
}

const stripHtml = (h) => String(h || '')
  .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|tr)>/gi, '\n')
  .replace(/<li>/gi, '- ').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

async function getWorkItem(id) {
  const w = await ado(`${ORG}/${proj}/_apis/wit/workitems/${id}?$expand=relations&api-version=7.1`);
  const f = w.fields;
  const prRefs = (w.relations || [])
    .map((r) => decodeURIComponent(r.url || ''))
    .filter((u) => u.includes('vstfs:///Git/PullRequestId/'))
    .map((u) => { const p = u.split('/'); return { repoId: p[p.length - 1].split('%2F')[1] ?? p[p.length - 2], raw: u }; })
    .map((x) => { const m = x.raw.match(/PullRequestId\/(.+)$/); const parts = decodeURIComponent(m[1]).split('/'); return { repoId: parts[1], prId: parts[2] }; });
  return {
    id,
    type: f['System.WorkItemType'],
    state: f['System.State'],
    tags: f['System.Tags'] || '',
    title: f['System.Title'],
    assignedTo: f['System.AssignedTo']?.displayName || '-',
    areaPath: f['System.AreaPath'] || '',
    description: stripHtml(f['System.Description']),
    reproSteps: stripHtml(f['Microsoft.VSTS.TCM.ReproSteps']),
    acceptanceCriteria: stripHtml(f['Microsoft.VSTS.Common.AcceptanceCriteria']),
    prRefs,
  };
}

const CODE_EXT = /\.(cs|ts|html|scss|css|js|sql|py)$/i;
const TEST_PATH = /\/src\/Tests\/|\.spec\.|Test\.cs$|\.test\./i;
// mudancas SO nessa pasta (frontend) nao sao reprovadas por falta de teste — apenas aviso
const SPA_PATH = /^\/Sittax\.Spa\//i;
// arquivos que NAO comportam teste unitario (integracao externa / envio) — nem avisa nem reprova, so gera roteiro
const NO_TEST_NEEDED = [
  /\/Sittax\.Domain\/Serpro\/Services\/IntegraContadorServicesBase\.cs$/i,
  /\/Sittax\.Domain\/Serpro\/Services\/ConsultarFaturamentoIntegraContadorServices\.cs$/i,
  /\/Consumers\/ConsultarUltimaDeclaracaoPeloSerproConsumer\.cs$/i,
];
const isNoTestNeeded = (p) => NO_TEST_NEEDED.some((re) => re.test(p));
// Heuristica de integracao com sistema EXTERNO (fila/HTTP/API de terceiro) — nao comporta
// teste unitario. Pega os casos obvios por nome/pasta sem gastar IA. Extensivel.
const EXTERNAL_INTEGRATION = /(Consumer|Producer|Publisher|HttpClient|ApiClient|RestClient|Gateway|Webhook)\.cs$|IntegraContador\w*\.cs$|\/(Serpro|Ecac)\//i;
// arquivo que nao exige teste: nao-testavel explicito OU integracao externa
const naoExigeTeste = (p) => isNoTestNeeded(p) || EXTERNAL_INTEGRATION.test(p);
// repositorios cujos arquivos nao comportam teste unitario (E2E/UI) — isentos, igual a NO_TEST_NEEDED
const NO_TEST_REPOS = ['sittax.ui.test'];
const isNoTestRepo = (repoName) => NO_TEST_REPOS.includes(String(repoName || '').toLowerCase());

async function fileAtBranch(base, filePath, version, versionType = 'branch') {
  return ado(`${base}/items?path=${encodeURIComponent(filePath)}&versionDescriptor.version=${encodeURIComponent(version)}&versionDescriptor.versionType=${versionType}&api-version=7.1&$format=text`, { asText: true });
}

// diff unificado local entre base e head — manda so o que mudou, nao o arquivo inteiro
async function unifiedDiff(baseTxt, headTxt) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qadiff-'));
  const a = path.join(dir, 'a'); const b = path.join(dir, 'b');
  fs.writeFileSync(a, baseTxt); fs.writeFileSync(b, headTxt);
  try {
    const { stdout } = await execFileP('diff', ['-u', a, b], { maxBuffer: 8 * 1024 * 1024 }).catch((e) => e); // diff sai com 1 quando ha diferencas
    return (stdout || '').split('\n').slice(2).join('\n'); // remove cabecalho ---/+++ com paths temporarios
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function getPrContext(repoId, prId) {
  const base = `${ORG}/${proj}/_apis/git/repositories/${repoId}`;
  const pr = await ado(`${base}/pullRequests/${prId}?api-version=7.1`);
  const branch = pr.sourceRefName.replace('refs/heads/', '');
  const targetBranch = pr.targetRefName.replace('refs/heads/', '');
  // PR completado tem a branch de origem apagada -> le os arquivos pelo commit de merge
  const headVer = pr.status === 'completed' && pr.lastMergeSourceCommit?.commitId
    ? { value: pr.lastMergeSourceCommit.commitId, type: 'commit' }
    : { value: branch, type: 'branch' };
  const iters = await ado(`${base}/pullRequests/${prId}/iterations?api-version=7.1`);
  const last = iters.value[iters.value.length - 1].id;
  const ch = await ado(`${base}/pullRequests/${prId}/iterations/${last}/changes?api-version=7.1&$top=300&$compareTo=0`);
  const files = (ch.changeEntries || []).filter((c) => c.item && c.item.path && !c.item.isFolder)
    .map((c) => ({ changeType: c.changeType, path: c.item.path }));
  const testFiles = files.filter((f) => TEST_PATH.test(f.path));
  const codeFiles = files.filter((f) => CODE_EXT.test(f.path) && !TEST_PATH.test(f.path) && f.changeType !== 'delete');

  // baixa o conteudo (diff ou arquivo novo) de uma lista de arquivos do PR
  async function excerptsFor(list, limit) {
    const out = [];
    for (const f of list.slice(0, limit)) {
      if (f.changeType === 'delete') continue;
      try {
        const head = await fileAtBranch(base, f.path, headVer.value, headVer.type);
        if (/add/.test(f.changeType)) {
          out.push({ path: f.path, kind: 'arquivo novo', content: head.length > MAX_FILE_CHARS ? head.slice(0, MAX_FILE_CHARS) + '\n...[TRUNCADO]' : head });
        } else {
          const baseTxt = await fileAtBranch(base, f.path, targetBranch).catch(() => '');
          let d = await unifiedDiff(baseTxt, head);
          if (d.length > MAX_DIFF_CHARS) d = d.slice(0, MAX_DIFF_CHARS) + '\n...[DIFF TRUNCADO]';
          out.push({ path: f.path, kind: 'diff', content: d || '(sem diferencas no conteudo)' });
        }
      } catch { /* arquivo binario ou inacessivel */ }
    }
    return out;
  }
  const excerpts = await excerptsFor(codeFiles, MAX_FILES_PER_PR);
  // conteudo dos arquivos de teste: necessario para avaliar se o teste COBRE o criterio (nao so se existe)
  const testExcerpts = await excerptsFor(testFiles, MAX_FILES_PER_PR);
  return {
    prId, repoId,
    repoName: pr.repository?.name || '',
    noTestRepo: isNoTestRepo(pr.repository?.name),
    title: pr.title, description: pr.description || '', branch,
    status: pr.status, author: pr.createdBy?.displayName,
    files, testFiles, excerpts, testExcerpts,
    url: `${ORG}/${proj}/_git/${pr.repository?.name || repoId}/pullrequest/${prId}`,
  };
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
        try { const env = JSON.parse(out); if (typeof env.result === 'string') why = env.result.slice(0, 300); } catch { if (!why) why = (out || '').slice(0, 300); }
        return reject(new Error(`claude saiu com codigo ${code}: ${why || '(sem saida)'}`));
      }
      try { const env = JSON.parse(out); resolve(typeof env.result === 'string' ? env.result : out); } catch { resolve(out); }
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

function buildPrompt(wi, prs) {
  const prSections = prs.map((pr) => {
    const fileList = pr.files.map((f) => `${f.changeType}: ${f.path}`).join('\n');
    const tests = pr.testFiles.length
      ? `SIM — arquivos de teste no PR:\n${pr.testFiles.map((f) => f.path).join('\n')}`
      : 'NAO — o PR nao altera nenhum arquivo de teste';
    const code = pr.excerpts.map((e) => `--- ${e.path} (${e.kind}) ---\n${e.content}`).join('\n\n');
    const testCode = pr.testExcerpts?.length
      ? '\n\nCONTEUDO DOS TESTES DO PR (avalie se COBREM a mudanca, nao so se existem):\n' +
        pr.testExcerpts.map((e) => `--- ${e.path} (${e.kind}) ---\n${e.content}`).join('\n\n')
      : '';
    return `### PR #${pr.prId}: ${pr.title}\nBranch: ${pr.branch} | Status: ${pr.status} | Autor: ${pr.author}\nDescricao: ${pr.description}\n\nARQUIVOS ALTERADOS:\n${fileList}\n\nPR INCLUI TESTE AUTOMATIZADO? ${tests}\n\nMUDANCAS (diff unificado por arquivo; arquivos novos vem inteiros):\n${code}${testCode}`;
  }).join('\n\n');

  return `Voce e um analista de QA senior do Sittax (sistema fiscal/contabil SaaS: importacao de XML de notas, apuracao de impostos, Simples Nacional, DIFAL, transmissao de declaracoes, painel web Angular).

Sua tarefa: criar o ROTEIRO DE QA para a atividade abaixo, que esta na fila de Review. O QA que vai executar nao conhece o codigo — escreva passos concretos de tela/API, nao passos de programador.

## ATIVIDADE #${wi.id} [${wi.type}]
Titulo: ${wi.title}
Area: ${wi.areaPath}
Responsavel (dev): ${wi.assignedTo}
Descricao: ${wi.description || '(vazia)'}
Passos de reproducao (do bug): ${wi.reproSteps || '(nao informado)'}
Criterios de aceite: ${wi.acceptanceCriteria || '(nao informado)'}

## PULL REQUESTS VINCULADOS
${prSections}

REGRAS:
1. Os passos devem ser executaveis por um QA no ambiente de homologacao: onde clicar/navegar, que dados usar (cite cenarios concretos a partir do codigo: ex. se a correcao trata grupo economico, o passo deve dizer "use um escritorio FILHO de um grupo economico com configuracao propria de DIFAL diferente da do pai").
2. Derive os cenarios do DIFF: o que exatamente mudou de comportamento? Teste o caso corrigido E os casos vizinhos que podem ter regredido.
3. "precisa_validacao_manual": false somente se a mudanca for totalmente coberta por teste automatizado confiavel E sem efeito visual/fluxo (raro). Em geral bugs de calculo/exibicao precisam validacao manual.
4. "teste_automatizado": diga se o PR ja inclui teste (fato informado acima), se DEVERIA incluir e o que exatamente deveria ser coberto (classe/cenario). Para mudanca de frontend visual, teste automatizado pode ser dispensavel — justifique.
4a. "comunicacao_externa": marque "isento": true SOMENTE se a mudanca for EXCLUSIVAMENTE encanamento de integracao com sistema EXTERNO (consumer/producer de fila, cliente HTTP/REST de terceiro, chamada a API externa como SERPRO, Ecac/Receita, gateway de pagamento) — codigo de I/O de fronteira que nao comporta teste unitario significativo. Se a mudanca tiver QUALQUER logica de negocio testavel (calculo, regra, transformacao, decisao) junto, "isento": false — essa parte exige teste. Na duvida, false.
4b. "qualidade_do_teste" (so quando o PR inclui teste): com o CONTEUDO dos testes em maos, avalie se eles realmente COBREM o cenario corrigido e os criterios de aceite — nao basta existir. Marque "cobre_criterio": false e severidade quando o teste for fraco (ex.: assert trivial tipo Assert.True(true); testa um caminho diferente do bug; sem assert no valor que mudou; mocka justamente a parte corrigida; nao cobre o cenario dos criterios de aceite). Isto e um AVISO para o QA olhar de perto, NAO uma reprovacao. Se nao houver teste no PR, retorne "qualidade_do_teste": null.
5. Se a descricao da atividade estiver vazia, infira o contexto pelo titulo e pelo codigo, e diga no campo "observacoes" que a atividade esta sem descricao/criterios de aceite (isso e um problema de processo).
6. Senha/login, URLs internas e dados reais voce NAO conhece — escreva os passos de forma parametrizada ("acesse o painel como escritorio X com configuracao Y").
7. SEJA CONCISO: campos de texto com 1-2 frases; no maximo 10 passos de teste e 4 cenarios de regressao; nao repita a descricao da atividade; sem preambulo.

RESPONDA APENAS com JSON valido:
{
  "resumo_da_mudanca": "2-3 frases em pt-BR explicando o que foi alterado, para o QA entender o contexto",
  "precisa_validacao_manual": true|false,
  "justificativa_validacao": "...",
  "passos_de_teste": [
    { "passo": 1, "acao": "o que fazer", "dados": "massa de dados/configuracao necessaria", "resultado_esperado": "o que deve acontecer" }
  ],
  "cenarios_de_regressao": [ { "cenario": "...", "resultado_esperado": "..." } ],
  "teste_automatizado": {
    "pr_ja_inclui": true|false,
    "necessario": true|false,
    "justificativa": "...",
    "sugestao": "o que cobrir e onde (ex.: teste unitario em X cobrindo cenario Y), ou null"
  },
  "comunicacao_externa": {
    "isento": true|false,
    "motivo": "1 frase: por que e (ou nao e) so integracao externa sem logica testavel"
  },
  "qualidade_do_teste": {
    "cobre_criterio": true|false,
    "severidade": "alta|media|baixa",
    "analise": "1-2 frases: o que o teste cobre de fato e o que falta para validar a mudanca/criterio de aceite"
  },
  "riscos": [ "..." ],
  "observacoes": [ "..." ]
}`;
}

// ---------- render ----------
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function renderHtml(wi, prs, rep, avisoSpaSemTeste = false, prsInacessiveis = 0) {
  const H = [];
  H.push(`<p><b>🧪 Roteiro de QA (gerado automaticamente)</b> — #${wi.id} ${esc(wi.title)}</p>`);
  if (prsInacessiveis) {
    H.push(`<p><b>⚠️ Análise parcial:</b> ${prsInacessiveis} PR(s) vinculado(s) estão em repositório inacessível (deletado/movido) e foram ignorados. Verifique a cobertura de teste manualmente nesses PRs.</p>`);
  }
  if (avisoSpaSemTeste) {
    H.push('<p><b>⚠️ AVISO: PR sem teste automatizado.</b> A atividade não foi reprovada porque a mudança é restrita ao frontend (<code>Sittax.Spa</code>), mas avalie a sugestão de cobertura abaixo.</p>');
  }
  H.push(`<p>${esc(rep.resumo_da_mudanca)}</p>`);
  H.push(`<p><b>Validação manual:</b> ${rep.precisa_validacao_manual ? '✅ NECESSÁRIA' : '➖ dispensável'} — ${esc(rep.justificativa_validacao)}</p>`);
  const ta = rep.teste_automatizado || {};
  H.push(`<p><b>Teste automatizado:</b> PR ${ta.pr_ja_inclui ? 'JÁ INCLUI ✅' : 'NÃO inclui ❌'} | ${ta.necessario ? 'necessário' : 'dispensável'} — ${esc(ta.justificativa)}${ta.sugestao ? ` <i>Sugestão: ${esc(ta.sugestao)}</i>` : ''}</p>`);
  // aviso de qualidade do teste: o PR tem teste, mas ele pode nao cobrir o que mudou (nao reprova, alerta)
  const qt = rep.qualidade_do_teste;
  if (qt && qt.cobre_criterio === false) {
    const sevIcon = { alta: '🔴', media: '🟠', baixa: '🟡' };
    H.push(`<p><b>${sevIcon[qt.severidade] || '⚠️'} Atenção — qualidade do teste:</b> o PR inclui teste, mas pode não cobrir a mudança. ${esc(qt.analise)} <i>(valide manualmente este ponto)</i></p>`);
  } else if (qt && qt.cobre_criterio === true) {
    H.push(`<p><b>✅ Qualidade do teste:</b> ${esc(qt.analise)}</p>`);
  }
  if (rep.passos_de_teste?.length) {
    H.push('<p><b>Passo a passo:</b></p><ol>');
    for (const p of rep.passos_de_teste) {
      H.push(`<li><b>${esc(p.acao)}</b>${p.dados ? `<br/>Dados: ${esc(p.dados)}` : ''}<br/>✔️ Esperado: ${esc(p.resultado_esperado)}</li>`);
    }
    H.push('</ol>');
  }
  if (rep.cenarios_de_regressao?.length) {
    H.push('<p><b>Regressão (conferir que não quebrou):</b></p><ul>');
    for (const c of rep.cenarios_de_regressao) H.push(`<li>${esc(c.cenario)} — esperado: ${esc(c.resultado_esperado)}</li>`);
    H.push('</ul>');
  }
  if (rep.riscos?.length) {
    H.push('<p><b>Riscos:</b></p><ul>');
    for (const r of rep.riscos) H.push(`<li>⚠️ ${esc(r)}</li>`);
    H.push('</ul>');
  }
  if (rep.observacoes?.length) {
    H.push('<p><b>Observações:</b></p><ul>');
    for (const o of rep.observacoes) H.push(`<li>${esc(o)}</li>`);
    H.push('</ul>');
  }
  H.push(`<p><i>PRs analisados: ${prs.map((p) => `<a href="${p.url}">#${p.prId}</a>`).join(', ')} | sittax-qa-review (${esc(flags.model)})</i></p>`);
  return H.join('');
}

async function postComment(wiId, html) {
  await ado(`${ORG}/${proj}/_apis/wit/workItems/${wiId}/comments?api-version=7.1-preview.3`, {
    method: 'POST', body: { text: html },
  });
}

// reprovacao por falta de teste: zero tokens de IA — deteccao por codigo + comentario + estado Rejected
// motivo: 'ausencia' (PR sem teste) ou 'cobertura' (tem teste, mas nao cobre a mudanca)
async function autoReject(wi, prs, { motivo = 'ausencia', qt = null } = {}) {
  // nao duplica comentario quando o dev devolve pra Review sem corrigir
  const prev = await ado(`${ORG}/${proj}/_apis/wit/workItems/${wi.id}/comments?api-version=7.1-preview.3`);
  const jaReprovada = (prev.comments || []).some((c) => (c.text || '').includes('REPROVADO —'));
  if (jaReprovada) {
    log('  ja tem comentario de reprovacao — so movendo estado, sem novo comentario');
    await moveToRejected(wi);
    return;
  }
  const H = [];
  if (motivo === 'cobertura') {
    H.push('<p><b>❌ REPROVADO — teste não cobre a mudança</b></p>');
    H.push(`<p>O(s) PR(s) (${prs.map((p) => `<a href="${p.url}">#${p.prId}</a>`).join(', ')}) incluem teste, mas ele <b>não exercita a correção</b>${qt?.severidade ? ` (severidade ${esc(qt.severidade)})` : ''}.</p>`);
    if (qt?.analise) H.push(`<p>${esc(qt.analise)}</p>`);
    H.push('<p>Ajuste o teste para cobrir de fato o comportamento corrigido e devolva a atividade para Review — a validação será refeita automaticamente.</p>');
  } else {
    H.push('<p><b>❌ REPROVADO — falta de teste automatizado</b></p>');
    H.push(`<p>O(s) PR(s) vinculado(s) (${prs.map((p) => `<a href="${p.url}">#${p.prId}</a>`).join(', ')}) não alteram nenhum arquivo de teste (<code>/src/Tests/</code>, <code>.spec.ts</code>, <code>*Test.cs</code>).</p>`);
    H.push('<p>Inclua teste automatizado cobrindo a mudança e devolva a atividade para Review — a validação de QA será refeita automaticamente.</p>');
  }
  H.push('<p><i>⚔️ You shall not pass! Código retido até a inclusão dos testes. — The White Sentinel</i></p>');
  await postComment(wi.id, H.join(''));
  await moveToRejected(wi);
}

const TAG_REPROVADA = 'reprovada-sem-teste';

async function moveToRejected(wi) {
  // Bugs exigem o campo "Data retorno"
  const patch = [{ op: 'replace', path: '/fields/System.State', value: 'Rejected' }];
  // tag para metricas: filtravel em query/board por System.Tags Contains 'reprovada-sem-teste'
  if (!(wi.tags || '').toLowerCase().includes(TAG_REPROVADA)) {
    patch.push({ op: 'add', path: '/fields/System.Tags', value: wi.tags ? `${wi.tags}; ${TAG_REPROVADA}` : TAG_REPROVADA });
  }
  const url = `${ORG}/${proj}/_apis/wit/workitems/${wi.id}?api-version=7.1`;
  const t = await token();
  const doPatch = (body) => fetch(url, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json-patch+json' },
    body: JSON.stringify(body),
  });
  let res = await doPatch(patch);
  if (!res.ok) {
    res = await doPatch([...patch, { op: 'add', path: '/fields/Custom.Dataretorno', value: new Date().toISOString() }]);
  }
  if (!res.ok) throw new Error(`mover para Rejected falhou: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
}

const MARKER = 'Roteiro de QA (gerado automaticamente)';

async function hasRoteiro(wiId) {
  const r = await ado(`${ORG}/${proj}/_apis/wit/workItems/${wiId}/comments?api-version=7.1-preview.3`);
  return (r.comments || []).some((c) => (c.text || '').includes(MARKER));
}

// ---------- main ----------
const dir = path.join(ROOT, 'reports');
fs.mkdirSync(dir, { recursive: true });

// lock: evita duas execucoes simultaneas (ex.: watcher disparando durante analise longa)
const lockPath = path.join(dir, '.lock');
if (fs.existsSync(lockPath)) {
  const age = Date.now() - fs.statSync(lockPath).mtimeMs;
  if (age < 45 * 60 * 1000) { log(`Outra execucao em andamento (lock ha ${Math.round(age / 60000)}min) — saindo.`); process.exit(0); }
  log('Lock antigo (>45min) — assumindo execucao morta e continuando.');
}
fs.writeFileSync(lockPath, String(process.pid), 'utf8');
const releaseLock = () => { try { fs.unlinkSync(lockPath); } catch { /* ja removido */ } };
process.on('exit', releaseLock);
process.on('SIGINT', () => { releaseLock(); process.exit(130); });

let targets = flags.queue ? await queueIds() : ids;

const processedPath = path.join(dir, 'processed.json');
const processed = new Set(fs.existsSync(processedPath) ? JSON.parse(fs.readFileSync(processedPath, 'utf8')) : []);
if (flags.newOnly) {
  targets = targets.filter((id) => !processed.has(id));
  // segunda guarda: pula se a atividade ja tem roteiro postado no Discussion
  const fresh = [];
  for (const id of targets) {
    if (await hasRoteiro(id)) { processed.add(id); log(`#${id}: ja tem roteiro no Discussion — pulando.`); }
    else fresh.push(id);
  }
  targets = fresh;
  fs.writeFileSync(processedPath, JSON.stringify([...processed]), 'utf8');
  if (!targets.length) { log('Nada novo em Review.'); process.exit(0); }
}
log(`Atividades a analisar (${targets.length}): ${targets.join(', ')}`);

const summary = [];
for (const id of targets) {
  try {
    log(`\n=== #${id} ===`);
    const wi = await getWorkItem(id);
    log(`[${wi.type}] ${wi.title}`);
    const prs = [];
    let prsInacessiveis = 0;
    for (const ref of wi.prRefs) {
      log(`  baixando PR #${ref.prId}...`);
      try {
        prs.push(await getPrContext(ref.repoId, ref.prId));
      } catch (e) {
        // repo deletado/movido (404) ou sem acesso — pula esse PR e segue com os demais
        prsInacessiveis++;
        log(`  AVISO: PR #${ref.prId} inacessivel (${(e.message || '').slice(0, 80)}) — ignorado.`);
      }
    }
    if (!prs.length && wi.prRefs.length) {
      log('  ERRO: todos os PRs vinculados estao inacessiveis — pulando atividade.');
      summary.push({ id, ok: false, erro: 'todos os PRs inacessiveis' });
      continue;
    }
    if (!prs.length) log('  AVISO: sem PR vinculado — analise so pelo work item.');
    let avisoSpaSemTeste = false;
    // Regra de reprovacao (a sua): SO mudanca em SPA e isenta; o resto, se nao tem teste
    // que cobre a mudanca, reprova. Calculamos uma vez se a atividade EXIGE teste real.
    const autoRejAtivo = flags.autoReject && !prsInacessiveis && prs.length;
    let exigeTesteReal = false; // ha arquivo nao-isento, fora de SPA e fora da lista de nao-testaveis
    if (flags.autoReject && prsInacessiveis) {
      // nao reprovar se algum PR ficou inacessivel — o teste pode estar no PR que nao conseguimos ler
      log('  AVISO: ha PR(s) inacessivel(is) — auto-reject desativado para esta atividade (nao da pra afirmar que falta teste).');
    }
    if (autoRejAtivo) {
      // cada arquivo carrega se o PR dele e de um repo isento (ex.: Sittax.Ui.Test = E2E)
      const arquivos = prs.flatMap((p) => p.files.map((f) => ({ path: f.path, isento: p.noTestRepo })));
      const exigemTeste = arquivos.filter((a) => !a.isento && !SPA_PATH.test(a.path) && !naoExigeTeste(a.path));
      const temSpa = arquivos.some((a) => !a.isento && SPA_PATH.test(a.path));
      exigeTesteReal = exigemTeste.length > 0;
      const semTeste = prs.every((p) => !p.testFiles.length);
      if (semTeste) {
        const soNaoTestaveis = arquivos.length > 0 && !exigeTesteReal && !temSpa;
        if (soNaoTestaveis) {
          log('  ℹ️ sem teste, mas mudanca SO em arquivo(s) que nao comporta(m) teste unitario — roteiro normal, sem aviso/reprovacao');
        } else if (!exigeTesteReal) {
          // sobrou so SPA (eventualmente + nao-testaveis) -> aviso, sem reprovacao
          avisoSpaSemTeste = true;
          log('  ⚠️ sem teste, mas mudanca SO em Sittax.Spa — warning no roteiro em vez de reprovacao');
        } else {
          log(`  arquivos que exigem teste: ${exigemTeste.slice(0, 5).map((a) => a.path).join(', ')}`);
          if (!flags.comment) {
            log('  DRY-RUN (--no-comment): seria reprovada (ausencia de teste), nada postado/movido.');
            summary.push({ id, title: wi.title, rejeitada: true, motivo: 'ausencia', dryRun: true, ok: true });
            continue;
          }
          await autoReject(wi, prs, { motivo: 'ausencia' });
          log(`  ❌ sem teste no PR — reprovada e movida para Rejected (sem gastar IA)`);
          summary.push({ id, title: wi.title, rejeitada: true, motivo: 'ausencia', ok: true });
          continue;
        }
      }
    }
    const prompt = buildPrompt(wi, prs);
    log(`  prompt: ${(prompt.length / 1000).toFixed(0)}k chars | analisando com ${flags.model}...`);
    const raw = await runClaude(prompt, flags.model);
    const rep = extractJson(raw);
    fs.writeFileSync(path.join(dir, `wi-${id}.json`), JSON.stringify({ wi: { id: wi.id, title: wi.title }, rep }, null, 2), 'utf8');

    // Regra (sua): tem teste, mas NAO cobre a mudanca, e a atividade exige teste real (nao-SPA) -> reprova.
    // SPA segue isento (cai no roteiro/aviso). Reprovacao por qualidade so com veredito claro do modelo.
    // Trava: se a mudanca e SO integracao externa (Claude julgou pelo diff), nao reprova.
    const testeNaoCobre = rep.qualidade_do_teste?.cobre_criterio === false;
    const isentoExterno = rep.comunicacao_externa?.isento === true;
    if (isentoExterno) log('  ℹ️ mudanca classificada como integracao externa (sem logica testavel) — isenta de reprovacao por teste');
    if (autoRejAtivo && exigeTesteReal && testeNaoCobre && !isentoExterno) {
      if (!flags.comment) {
        log('  DRY-RUN (--no-comment): seria reprovada (teste nao cobre a mudanca), nada postado/movido.');
        summary.push({ id, title: wi.title, rejeitada: true, motivo: 'cobertura', dryRun: true, ok: true });
        continue;
      }
      await autoReject(wi, prs, { motivo: 'cobertura', qt: rep.qualidade_do_teste });
      log(`  ❌ teste nao cobre a mudanca — reprovada e movida para Rejected`);
      summary.push({ id, title: wi.title, rejeitada: true, motivo: 'cobertura', ok: true });
      continue;
    }

    if (flags.comment) {
      await postComment(id, renderHtml(wi, prs, rep, avisoSpaSemTeste, prsInacessiveis));
      log(`  ✅ comentario postado: ${ORG}/${proj}/_workitems/edit/${id}`);
      processed.add(id);
      fs.writeFileSync(processedPath, JSON.stringify([...processed]), 'utf8');
    }
    summary.push({ id, title: wi.title, manual: rep.precisa_validacao_manual, temTeste: rep.teste_automatizado?.pr_ja_inclui, precisaTeste: rep.teste_automatizado?.necessario, testeFraco: rep.qualidade_do_teste?.cobre_criterio === false, passos: rep.passos_de_teste?.length || 0, ok: true });
  } catch (e) {
    log(`  ❌ ERRO em #${id}: ${e.message.slice(0, 300)}`);
    summary.push({ id, ok: false, erro: e.message.slice(0, 200) });
  }
}

fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
console.log('\n===== RESUMO =====');
for (const s of summary) {
  if (!s.ok) { console.log(`#${s.id}: ERRO — ${s.erro}`); continue; }
  if (s.rejeitada) { console.log(`#${s.id}: ❌ REPROVADA (${s.motivo === 'cobertura' ? 'teste não cobre a mudança' : 'sem teste no PR'}${s.dryRun ? ', dry-run' : ''}) | ${s.title.slice(0, 70)}`); continue; }
  console.log(`#${s.id}: ${s.passos} passos | manual: ${s.manual ? 'SIM' : 'nao'} | PR tem teste: ${s.temTeste ? 'sim' : 'NAO'}${s.testeFraco ? ' (⚠️ FRACO)' : ''} | teste necessario: ${s.precisaTeste ? 'SIM' : 'nao'} | ${s.title.slice(0, 70)}`);
}
