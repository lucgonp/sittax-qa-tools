# Convenção de tags de QA (instrumentação de métricas)

Para o relatório semanal medir o que antes era "cego", as ferramentas de QA passam a
aplicar tags padronizadas nos work items. Todas são filtráveis por WIQL
(`[System.Tags] CONTAINS 'x'`) e por board.

| Tag | Significa | Quem aplica | Quando |
|---|---|---|---|
| `producao` | Bug escapou para **produção** | sittax-bug-triage | Automático, na criação (origem = fila `_error` de Prod) |
| `reincidente` | Voltou a falhar **após a entrega** | sittax-bug-triage / `recheck.mjs` | Automático, quando a assinatura reaparece após Done/Deploy |
| `reprovada-sem-teste` | PR barrado por **falta de teste** | sittax-qa-review | Automático, no auto-reject |

### Queries que o relatório usa

```sql
-- Bugs em produção criados na semana
[System.Tags] CONTAINS 'producao' AND [System.CreatedDate] >= '<ini>' AND < '<fim>'

-- Reincidências marcadas na semana (taxa de retrabalho real)
[System.Tags] CONTAINS 'reincidente' AND [System.ChangedDate] >= '<ini>' AND < '<fim>'

-- Reprovações pelo QA
[System.Tags] CONTAINS 'reprovada-sem-teste'
```

### Ainda pendente de instrumentação: cobertura % por produto

Não é tag — depende de **export do resultado do CI** (Cypress/Jenkins). Hoje o
relatório usa um proxy (bugs por produto). Para virar número real:

1. Publicar o pipeline (`Sittax.Ui.Test`, PR #5701) que já gera `test-results-*.xml` (JUnit) por suíte.
2. O relatório semanal lê esses artefatos (contagem de testes/asserts por área) e
   consolida "testes executados por produto" — proxy de cobertura até haver um
   coverage tool de verdade.

> Enquanto o pipeline não estiver no ar, a seção 3 do relatório continua marcando
> cobertura como ⚠️ não-instrumentada — sem inventar percentual.
