# 🧪 Homologação automática de leitores NFSe (sittax-homologa)

Ferramenta de QA que automatiza a homologação de PRs de leitura de XML de NFSe municipal, em **duas partes**:

| Parte | Script | O que valida | Quando rodar |
|---|---|---|---|
| **1 — Estática** | `homologa.mjs` | Asserts do teste vs **XML cru** da prefeitura | Assim que o PR abre (qualquer momento) |
| **2 — End-to-end** | `stage.mjs` | O que o **sistema gravou em staging** vs asserts do teste | **Depois** do PR completado + deploy de stage |

> 💡 **Por que existe**: o dev escreve o parser E os asserts do teste — o teste passar não prova nada (ele pode ter copiado a saída do parser pros asserts). A parte 1 confere cada valor contra o XML original da prefeitura. A parte 2 importa o XML de verdade no stage e confere o que apareceu nas telas de entrada/saída.

---

## ✅ Pré-requisitos (uma vez só)

- Máquina com WSL (Ubuntu-26.04) — a ferramenta vive em `~/sittax-homologa`
- `az login` ativo no WSL (mesmo login do bug-triage)
- `claude` CLI logado no WSL
- Credencial de stage: usa por padrão o usuário `sistema` de QA (o mesmo dos testes Cypress). Para trocar, crie `~/sittax-homologa/.env`:
  ```
  STAGE_USER=outro@sittax.com.br
  STAGE_PASS=...
  ```

---

## 🔁 Fluxo no processo de QA

```
PR aberto (fix/NNNNN-homologacao-<municipio>)
  │
  ├─► PARTE 1: node homologa.mjs <pr> --comment
  │      veredito aprovado? → segue o fluxo normal do PR
  │
PR completado + deploy de stage subiu (atividade em Review)
  │
  └─► PARTE 2: node stage.mjs <pr> --comment
         veredito aprovado? → homologação concluída, mover atividade
```

---

## 📋 Parte 1 — Conferência XML cru vs asserts

```bash
cd ~/sittax-homologa

node homologa.mjs 5671                  # por id
node homologa.mjs "<url do PR>"         # ou pela URL inteira
node homologa.mjs 5671 --comment        # analisa E posta no Discussion do work item
node homologa.mjs 5671 --comment-only   # reposta o relatório já gerado, sem nova análise
node homologa.mjs 5671 --model claude-fable-5   # casos difíceis (default: sonnet)
```

**O que ela confere**: campo a campo de cada nota assertada (números, datas, valores, CNPJs, endereços, municípios, status 100/101), classificação **entrada vs saída** (prestador→emitente, tomador→destinatário), contagem de notas do lote, cancelamentos, unicidade da chave de acesso, e **cobertura faltante** (notas/campos que o teste não confere).

**Saída**: relatório no terminal + `reports/pr-<id>.md` + `.json`.

---

## 🚀 Parte 2 — Importação real em staging

> ⚠️ **REGRA DE OURO**: só rode depois que o **PR foi completado e o deploy de stage subiu**. O stage executa o código deployado — rodar antes testa o parser ANTIGO e reprova injustamente.

```bash
cd ~/sittax-homologa

node stage.mjs 5671                  # fluxo completo: limpa → importa → consulta → confere
node stage.mjs 5671 --comment        # idem + posta o relatório no Discussion do work item
node stage.mjs 5671 --dry-run        # NÃO remove nem importa; só extrai chaves e consulta
node stage.mjs 5671 --no-cleanup     # importa sem remover as notas antes
node stage.mjs 5671 --comment-only   # posta o reports/pr-<id>-stage.json já gerado
```

**O que acontece por baixo**:

1. Baixa do PR os testes e fixtures XML (PR completado → busca pelo commit de merge).
2. Claude extrai do teste as notas **esperadas** (chave de acesso + campos assertados).
3. Remove essas chaves em stage → a rodada é **idempotente** (pode repetir à vontade).
4. Importa cada XML via `api/upload/importar-arquivo` (assíncrono via fila — faz polling de até ~1 min por chave).
5. Consulta cada chave nas telas de **entrada** e **saída** via API.
6. Claude compara o que o sistema gravou vs o que o teste espera (já sabe que `modelo 99` = NFSE e códigos IBGE = `TipoCidadesUtil`).

**Saída**: relatório no terminal + `reports/pr-<id>-stage.md` + `.json`.

---

## 📖 Como ler o relatório

| Veredito | Significa | Ação |
|---|---|---|
| ✅ **APROVADO** | Tudo conferiu | Comentar/mover a atividade |
| ⚠️ **COM RESSALVAS** | Divergências baixas/médias ou cobertura faltante | Ler as ressalvas e julgar |
| ❌ **REPROVADO** | Divergência alta (valor errado, nota não encontrada, tela errada) | Devolver pro dev com o relatório |

Sinais específicos da parte 2:

- **Nota NÃO ENCONTRADA em nenhuma tela** → parser não gerou a nota, chave divergente, deploy não subiu, **ou empresa não cadastrada em stage** (o relatório tenta diferenciar — confira se o CNPJ do prestador existe no ambiente).
- **Encontrada só em saída** (e o tomador tem CNPJ) → classificação entrada/saída suspeita.
- **Upload com `sucesso:false`** → leia a mensagem (extensões permitidas: .txt, .zip, .xml, .pdf).

---

## 🔧 Troubleshooting

| Sintoma | Causa | Solução |
|---|---|---|
| `Token vazio do az` | Sessão az expirou | `az login` no WSL |
| `claude saiu com codigo 1` | Rate limit transitório do CLI | Rodar de novo |
| `Login em stage falhou (401)` | Senha do usuário sistema mudou | Atualizar `.env` (creds de referência: `Sittax.Ui.Test:/cypress/fixtures/usuarios/usuarios.json`) |
| Upload retorna 404 | Endpoint errado | Tem que ser `api/upload/importar-arquivo` (o `upload-homologacao` síncrono NÃO está exposto em api.stage) |
| HTTP 403 "error code: 1010" | Cloudflare bloqueou | O script já manda User-Agent de browser; se mudar algo, manter |
| Nota não aparece nem com polling | Fila de stage lenta/parada | Conferir RabbitMQ de stage; rodar `--dry-run` depois pra só re-consultar |
| `TF401175 ... could not be resolved` | Versão antiga do script (branch apagada) | Atualizar: o script atual busca pelo commit de merge |

---

## 🗺️ Referência rápida da API de stage (descobertas que custaram caro)

- **Login**: `POST https://autenticacao.stage.sittax.com.br/api/auth/login` body `{usuario, senha}` → `{token}`. Mandar `User-Agent` de browser + `Origin/Referer: https://homologacao.sittax.com.br`.
- **Upload**: `POST https://api.stage.sittax.com.br/api/upload/importar-arquivo` (Bearer + multipart campo `arquivo`). Resposta `{sucesso:true}` ≠ importado — só enfileirou.
- **Consulta**: `GET api/nota-fiscal/obter-nota-fiscal-entrada?chaveAcesso=...` (global) e `obter-nota-fiscal-saida?chaveAcesso=...` (precisa do contexto de empresa: header `CnpjDaEmpresaSelecionada: <cnpj do prestador>` — header funciona, não precisa de cookie).
- **Limpeza**: `POST api/nota-fiscal/remover-notas-fiscais-por-chaves` body `{chavesAcesso:[...], cnpj:{numero}, motivo}`.

---

## 📦 Onde vive

- Código: `~/sittax-homologa` (WSL) | versionado em `~/sittax-qa-tools` → `github.com/lucgonp/sittax-qa-tools`
- Relatórios: `~/sittax-homologa/reports/`
- Caso de referência validado: **PR 5671** (Martinho Campos-MG, atividade #22700) — 3 notas, 2 lotes, 1 cancelamento, veredito ✅
