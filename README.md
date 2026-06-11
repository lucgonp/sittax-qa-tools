# sittax-qa-tools

Ferramentas de automação de QA da Sittax. Todas usam o Azure DevOps via `az` CLI
(rode `az login` uma vez) e o Claude Code CLI (`claude`, logado) — nenhum segredo
fica no código.

| Ferramenta | O que faz |
|---|---|
| [`homologa/`](homologa/) | Homologação automática de PRs de leitura de XML NFSe: confere cada assert do teste contra o XML cru da prefeitura, valida classificação entrada/saída, posta relatório no Discussion do work item. |
| [`qa-review/`](qa-review/) | Roteiro de QA para atividades em Review: analisa work item + diff do PR e posta passo a passo de teste, se precisa validação manual e se precisa teste automatizado. Com `--auto-reject`, reprova (comentário + estado Rejected) atividades cujo PR não tem teste — sem gastar IA. |
| [`watcher/`](watcher/) | Vigia: roda o qa-review a cada 15 min via Tarefa Agendada do Windows. |

## Uso rápido

```bash
# homologação de PR de NFSe (nº ou URL do PR) + postar no Discussion
node homologa/homologa.mjs 5671 --comment

# roteiro de QA para a fila Review inteira (só o que ainda não foi analisado)
node qa-review/qa-review.mjs --queue --new-only --auto-reject

# roteiro para uma atividade específica, sem postar (revisão prévia)
node qa-review/qa-review.mjs 24156 --no-comment

# reprovar manualmente por falta de teste (apaga roteiro, posta reprovação)
node qa-review/reprovar.mjs 24012
```

Modelo padrão: `claude-sonnet-4-6` (economia de tokens). Para análises mais
profundas: `--model claude-fable-5`.

## Instalando o vigia (Windows + WSL)

1. Copie `watcher/sittax-qa-watch.vbs` para uma pasta sua (ajuste o caminho do
   repositório dentro do .vbs se necessário);
2. No PowerShell:

```powershell
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument '"C:\caminho\sittax-qa-watch.vbs"'
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Minutes 15) -RepetitionDuration (New-TimeSpan -Days 3650)
Register-ScheduledTask -TaskName 'Sittax QA Review Watcher' -Action $action -Trigger $trigger -Force
```

Log: `/tmp/qa-watch.log` (no WSL). Estado de deduplicação: `qa-review/reports/processed.json`
(criado em runtime, fora do git). Requisitos: máquina ligada, usuário logado,
`az` e `claude` autenticados no WSL.

## Como funciona a deduplicação / re-validação

- Atividade analisada não é re-analisada (`processed.json` + marcador no Discussion);
- Atividade **reprovada** por falta de teste sai da fila (estado Rejected); quando o
  dev incluir o teste e devolvê-la pra Review, o vigia re-analisa e posta o roteiro;
- Lock em `reports/.lock` impede execuções simultâneas;
- Falha por limite de sessão do Claude = retry automático no ciclo seguinte.
