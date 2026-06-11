# sittax-homologa

Homologação automática de PRs de leitura de XML de NFSe municipal (Sittax).

No lugar de conferir na unha campo a campo, a ferramenta baixa do PR os testes e
os XMLs de exemplo da prefeitura e pede ao Claude uma verificação **independente**:
cada valor assertado no teste é conferido contra o XML cru — pegando o caso em que
o dev copiou a saída do parser para os asserts (teste passa, mas pode estar errado).

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

## Limitações

- O arquivo do leitor em si (`LeitorDeXml<Municipio>.cs`) só entra na análise se
  estiver no diff do PR; caso contrário a verificação é só dados (XML vs asserts).
- Não cobre a parte de importar o XML no app de staging (homologação end-to-end).
