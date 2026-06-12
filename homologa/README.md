# sittax-homologa

Homologação automática de PRs de leitura de XML de NFSe municipal (Sittax), em duas partes:

- **Parte 1 (`homologa.mjs`)** — verificação estática: baixa do PR os testes e os
  XMLs de exemplo da prefeitura e pede ao Claude uma verificação **independente**:
  cada valor assertado no teste é conferido contra o XML cru — pegando o caso em que
  o dev copiou a saída do parser para os asserts (teste passa, mas pode estar errado).
- **Parte 2 (`stage.mjs`)** — verificação end-to-end: importa os XMLs de verdade no
  ambiente de **staging**, consulta as notas geradas via API e confere o que o
  sistema gravou contra o que o teste espera.

## Uso

```bash
# por id ou pela URL inteira do PR
node homologa.mjs 5671
node homologa.mjs "https://dev.azure.com/Sittax/Sittax/_git/<repo>/pullrequest/5671"

# analisa E posta o relatório no Discussion do work item vinculado ao PR
node homologa.mjs 5671 --comment

# posta um relatório já gerado (reports/pr-5671.json) sem rodar nova análise
node homologa.mjs 5671 --comment-only

# outras opções
node homologa.mjs 5671 --model claude-sonnet-4-6   # modelo mais barato/rápido
node homologa.mjs 5671 --no-claude                  # só monta e imprime o prompt
```

O work item é descoberto pelo vínculo do PR no Azure DevOps; se o PR não tiver
vínculo, cai no fallback de extrair `#NNNNN` do título/descrição/branch.

Requisitos: `az login` ativo e `claude` CLI no PATH (mesmos do sittax-bug-triage).

## Saída

- Relatório Markdown no stdout e em `reports/pr-<id>.md`
- JSON estruturado em `reports/pr-<id>.json`

Seções: veredito (aprovado / aprovado com ressalvas / reprovado), divergências
assert vs XML, cobertura faltante (notas/campos sem assert), o que foi conferido
e bateu, e observações (ex.: typos vindos do XML da prefeitura).

## O que ela analisa

1. Cada nota assertada: número, série, datas, valores, CNPJs, endereços,
   código do município/serviço, status (100/101), itens.
2. Contagem de notas no lote e tratamento de cancelamento.
3. Cobertura: notas do lote e campos relevantes que o teste não confere.

## Parte 2 — importação em staging (`stage.mjs`)

Rode **depois que o PR foi completado e o deploy de stage subiu** (o stage executa o
código deployado, não a branch do PR — rodar antes testa o parser antigo).

```bash
node stage.mjs 5671                # remove chaves prévias, importa, consulta e confere
node stage.mjs 5671 --comment      # idem + posta o relatório no Discussion do work item
node stage.mjs 5671 --dry-run      # não remove nem importa; só extrai chaves e consulta
node stage.mjs 5671 --no-cleanup   # importa sem remover as notas antes
node stage.mjs 5671 --comment-only # posta o reports/pr-<id>-stage.json já gerado
```

O que ela faz:

1. Extrai do teste do PR as notas **esperadas** (chave de acesso + campos assertados).
2. Remove essas chaves em stage (`api/nota-fiscal/remover-notas-fiscais-por-chaves`)
   para a rodada ser idempotente.
3. Importa cada fixture XML via `api/upload/importar-arquivo` (processamento
   assíncrono via fila — a consulta faz polling de até ~1 min por chave).
4. Consulta cada chave em `obter-nota-fiscal-entrada` e `obter-nota-fiscal-saida`
   (saída usa o header `CnpjDaEmpresaSelecionada` com o CNPJ do prestador).
5. Claude compara o que o sistema gravou vs o que o teste espera (tratando
   equivalências de enum: modelo `99` = NFSE, códigos IBGE = `TipoCidadesUtil`).

Saída em `reports/pr-<id>-stage.md` + `.json`.

Credenciais de stage: por padrão usa o usuário `sistema` de QA (o mesmo dos testes
Cypress); para trocar, crie um `.env` com `STAGE_USER=` e `STAGE_PASS=`.

Nota: o endpoint síncrono `api/upload-homologacao/importar-arquivo` (que devolve a
quantidade importada) **não** está exposto em `api.stage.sittax.com.br` (404) — por
isso o upload usa o endpoint autenticado normal + polling.

## Limitações

- O arquivo do leitor em si (`LeitorDeXml<Municipio>.cs`) só entra na análise da
  parte 1 se estiver no diff do PR; caso contrário a verificação é só dados (XML vs asserts).
- Parte 2: se a empresa do CNPJ emitente/destinatário não estiver cadastrada em
  stage, a nota não aparece nas telas — o relatório aponta, mas não cadastra a empresa.
