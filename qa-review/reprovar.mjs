#!/usr/bin/env node
// reprovar.mjs: substitui o roteiro de QA por um comentario de reprovacao por falta de teste.
// Uso: node reprovar.mjs <id...>

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const ORG = 'https://dev.azure.com/Sittax';
const proj = encodeURIComponent('Sittax');
const MARKER = 'Roteiro de QA (gerado automaticamente)';

const ids = process.argv.slice(2).filter((a) => /^\d+$/.test(a));
if (!ids.length) { console.error('Uso: node reprovar.mjs <id...>'); process.exit(2); }

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
    headers: { Authorization: `Bearer ${t}`, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok && res.status !== 204) throw new Error(`Azure ${opts.method || 'GET'} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.status === 204 ? null : res.json();
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

for (const id of ids) {
  try {
    // relatorio salvo da analise (para citar a sugestao de teste)
    const repPath = path.join(ROOT, 'reports', `wi-${id}.json`);
    const saved = fs.existsSync(repPath) ? JSON.parse(fs.readFileSync(repPath, 'utf8')) : null;
    const sugestao = saved?.rep?.teste_automatizado?.sugestao || null;
    const justificativa = saved?.rep?.teste_automatizado?.justificativa || null;

    const base = `${ORG}/${proj}/_apis/wit/workItems/${id}/comments`;
    const list = await ado(`${base}?api-version=7.1-preview.3`);
    const roteiros = (list.comments || []).filter((c) => (c.text || '').includes(MARKER));
    for (const c of roteiros) {
      await ado(`${base}/${c.id}?api-version=7.1-preview.3`, { method: 'DELETE' });
      console.log(`#${id}: roteiro (comentario ${c.id}) apagado`);
    }

    const H = [];
    H.push(`<p><b>❌ REPROVADO — falta de teste automatizado</b></p>`);
    H.push(`<p>O PR vinculado a esta atividade <b>não inclui nenhum teste automatizado</b> cobrindo a mudança.</p>`);
    if (justificativa) H.push(`<p><b>Por que teste é necessário aqui:</b> ${esc(justificativa)}</p>`);
    if (sugestao) H.push(`<p><b>O que deve ser coberto:</b> ${esc(sugestao)}</p>`);
    H.push(`<p>Após incluir o(s) teste(s) no PR, sinalizar para nova validação de QA.</p>`);
    H.push(`<p><i>Validação automática de QA — sittax-qa-review</i></p>`);
    await ado(`${base}?api-version=7.1-preview.3`, { method: 'POST', body: { text: H.join('') } });
    console.log(`#${id}: comentario de reprovacao postado`);
  } catch (e) {
    console.error(`#${id}: ERRO — ${e.message.slice(0, 200)}`);
  }
}
