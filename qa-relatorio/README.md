# sittax-qa-relatorio

Relatório semanal de Qualidade (QA) a partir do Azure DevOps, com comparativo
semana-a-semana e narrativa gerada pelo Claude sobre os números apurados.

## Uso

```bash
node relatorio.mjs                       # semana passada (seg–dom), vs. a retrasada
node relatorio.mjs --week-start 2026-06-08   # força o início (uma segunda-feira)
node relatorio.mjs --no-claude           # só números/tabelas, sem narrativa
node relatorio.mjs --model claude-fable-5
```

Saída: `reports/Relatorio-QA-<ini>_a_<fim>.md` (+ `.json` com os dados crus).

## Como funciona

1. **Coleta determinística** (WIQL no Azure DevOps) da semana-alvo e da anterior:
   bugs criados/resolvidos, severidade, por produto/área/estado, PRs concluídos,
   itens em Review, testes novos, e as tags instrumentadas (`producao`,
   `reincidente`, `reprovada-sem-teste`).
2. **Tabelas** (seções 2–6) montadas direto dos números, com Δ vs. semana anterior.
3. **Narrativa** (seções 1, 7, 8, 9 e resumo final) gerada pelo `claude -p` a partir
   do JSON de métricas — com regras anti-alucinação (não inventa cobertura % nem
   estados/contagens que não estão nos dados).

## Métricas e instrumentação

As tags que tornam o relatório completo são aplicadas automaticamente pelas outras
ferramentas — ver `CONVENCOES-TAGS.md`:

- `producao` → bug-triage (todo bug nasce de erro em produção)
- `reincidente` → bug-triage/`recheck.mjs` (voltou a falhar após a entrega)
- `reprovada-sem-teste` → qa-review (PR barrado por falta de teste)

**Ainda ⚠️ não instrumentado:** cobertura % por produto (depende de export do CI —
o relatório usa "bugs por produto" como proxy e marca o gap, sem inventar número).

## Agendamento

Tarefa Agendada do Windows **"Sittax QA Relatorio Semanal"** roda
`C:\Users\New User\sittax-qa-relatorio.vbs` toda **segunda 08:00** (WSL, oculto;
log em `/tmp/qa-relatorio.log`). Requer máquina ligada + `az`/`claude` logados no WSL.

Para desativar: `schtasks /Delete /TN "Sittax QA Relatorio Semanal" /F`.

## Limitações conhecidas

- `reincidente`/`reprovada-sem-teste`/`producao` na semana são filtrados por data
  (CreatedDate/ChangedDate). Como `ChangedDate` reflete a última alteração, um item
  tocado depois pode sair da janela — rode o relatório logo após o fechamento da
  semana (segunda) para máxima precisão.
- Janela em UTC (Brasil = UTC-3): eventos da noite de domingo podem cair na semana seguinte.

Requisitos: `az login` (ou env `ADO_TOKEN`/`SYSTEM_ACCESSTOKEN` em pipeline) e `claude` no PATH.
