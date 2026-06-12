#!/usr/bin/env node
// remediar-spa.mjs: corrige atividades reprovadas indevidamente pela regra antiga.
// SPA-only sem teste -> apaga comentarios de reprovacao + volta para Review.
// Backend sem teste  -> mantem reprovacao, mas remove comentarios duplicados.
// Uso: node remediar-spa.mjs <id...>

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const ORG = 'https://dev.azure.com/Sittax';
const proj = encodeURIComponent('Sittax');
const SPA_PATH = /^\/Sittax\.Spa\//i;
const TEST_PATH = /\/src\/Tests\/|\.spec\.|Test\.cs$|\.test\./i;
const NO_TEST_NEEDED = [/\/Sittax\.Domain\/Serpro\/Services\/IntegraContadorServicesBase\.cs$/i];
const isNoTestNeeded = (p) => NO_TEST_NEEDED.some((re) => re.test(p));
const NO_TEST_REPOS = ['sittax.ui.test'];

const ids = process.argv.slice(2).filter((a) => /^\d+$/.test(a));
if (!ids.length) { console.error('Uso: node remediar-spa.mjs <id...>'); process.exit(2); }

let _token = null;
async function token() {
  if (_token) return _token;
  const { stdout } = await execFileP('az', ['account', 'get-access-token', '--resource', '499b84ac-1321-427f-aa17-267ca6975798', '--query', 'accessToken', '-o', 'tsv'], { maxBuffer: 4 * 1024 * 1024 });
  _token = stdout.trim();
  return _token;
}
async function ado(url, opts = {}) {
  const t = await token();
  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers: { Authorization: `Bearer ${t}`, ...(opts.body ? { 'Content-Type': opts.ct || 'application/json' } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok && res.status !== 204) throw new Error(`Azure ${opts.method || 'GET'} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.status === 204 ? null : res.json();
}

for (const id of ids) {
  try {
    const w = await ado(`${ORG}/${proj}/_apis/wit/workitems/${id}?$expand=relations&api-version=7.1`);
    const state = w.fields['System.State'];
    const prRefs = (w.relations || [])
      .map((r) => decodeURIComponent(r.url || ''))
      .filter((u) => u.includes('vstfs:///Git/PullRequestId/'))
      .map((u) => { const m = u.match(/PullRequestId\/(.+)$/); const parts = decodeURIComponent(m[1]).split('/'); return { repoId: parts[1], prId: parts[2] }; });

    let arquivos = [];      // { path, isento }
    let allFiles = [];
    for (const ref of prRefs) {
      const base = `${ORG}/${proj}/_apis/git/repositories/${ref.repoId}`;
      const pr = await ado(`${base}/pullRequests/${ref.prId}?api-version=7.1`);
      const isento = NO_TEST_REPOS.includes(String(pr.repository?.name || '').toLowerCase());
      const iters = await ado(`${base}/pullRequests/${ref.prId}/iterations?api-version=7.1`);
      const last = iters.value[iters.value.length - 1].id;
      const ch = await ado(`${base}/pullRequests/${ref.prId}/iterations/${last}/changes?api-version=7.1&$top=300&$compareTo=0`);
      for (const c of (ch.changeEntries || [])) {
        if (c.item && c.item.path && !c.item.isFolder) { arquivos.push({ path: c.item.path, isento }); allFiles.push(c.item.path); }
      }
    }
    const semTeste = !allFiles.some((p) => TEST_PATH.test(p));
    // arquivos que de fato exigiriam teste unitario: nao isento por repo, fora de SPA e fora da lista de nao-testaveis
    const exigemTeste = arquivos.filter((a) => !a.isento && !SPA_PATH.test(a.path) && !isNoTestNeeded(a.path));
    const reprovacaoIndevida = semTeste && arquivos.length > 0 && exigemTeste.length === 0;

    const cBase = `${ORG}/${proj}/_apis/wit/workItems/${id}/comments`;
    const list = await ado(`${cBase}?api-version=7.1-preview.3`);
    const reprovacoes = (list.comments || [])
      .filter((c) => (c.text || '').includes('REPROVADO — falta de teste'))
      .sort((a, b) => a.createdDate.localeCompare(b.createdDate));

    async function removerTag() {
      const wi2 = await ado(`${ORG}/${proj}/_apis/wit/workitems/${id}?api-version=7.1`);
      const tags = (wi2.fields['System.Tags'] || '').split(';').map((s) => s.trim()).filter(Boolean);
      const novas = tags.filter((t) => t.toLowerCase() !== 'reprovada-sem-teste');
      if (novas.length !== tags.length) {
        const t = await token();
        await fetch(`${ORG}/${proj}/_apis/wit/workitems/${id}?api-version=7.1`, {
          method: 'PATCH', headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json-patch+json' },
          body: JSON.stringify([{ op: 'replace', path: '/fields/System.Tags', value: novas.join('; ') }]),
        });
      }
    }

    if (reprovacaoIndevida) {
      for (const c of reprovacoes) {
        await ado(`${cBase}/${c.id}?api-version=7.1-preview.3`, { method: 'DELETE' });
      }
      await removerTag();
      console.log(`#${id}: reprovacao indevida (SPA/Ui.Test/nao-testavel) — ${reprovacoes.length} comentario(s) apagado(s), tag removida`);
      if (state === 'Rejected') {
        const t = await token();
        const res = await fetch(`${ORG}/${proj}/_apis/wit/workitems/${id}?api-version=7.1`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json-patch+json' },
          body: JSON.stringify([{ op: 'replace', path: '/fields/System.State', value: 'Review' }]),
        });
        console.log(`#${id}: estado Rejected -> Review (HTTP ${res.status})`);
      } else {
        console.log(`#${id}: estado atual ${state} — nao mexi no estado`);
      }
    } else {
      // reprovacao valida (backend): mantem a primeira, apaga duplicatas
      for (const c of reprovacoes.slice(1)) {
        await ado(`${cBase}/${c.id}?api-version=7.1-preview.3`, { method: 'DELETE' });
      }
      console.log(`#${id}: reprovacao mantida (exigem teste: ${exigemTeste.length}, estado=${state}) — ${Math.max(0, reprovacoes.length - 1)} duplicata(s) removida(s)`);
    }
  } catch (e) {
    console.error(`#${id}: ERRO — ${e.message.slice(0, 200)}`);
  }
}
