---
id: testar-instrucoes
titulo: Testar instruções do agente
resumo: Avalia se as instruções, memória e receitas do Estúdio funcionam corretamente em cenários controlados.
modo: leitura
combos: analise, revisor
---

> Ferramentas disponíveis: list_files, search_text, read_file,
> propose_file_write, run_script, consult_specialist, propose_learning.
> Esta receita é somente leitura para o projeto original — todas as
> execuções de teste ocorrem em cópias descartáveis.

## Fase 0 — Leia as instruções atuais

1. Use `read_file` no arquivo de configuração do agente (ex.: `AGENTE.md`,
   `docs/habblaud/config.md` ou equivalente) e em todos os arquivos de memória
   em `docs/habblaud/memory/`.
2. Use `list_files("shared/recipes")` para inventariar as
   receitas disponíveis.
3. Registre versão/revisão das instruções e data da avaliação antes de
   continuar.

## Fase 1 — Selecione casos de teste relevantes

4. Escolha casos aplicáveis às capacidades adotadas. Comece sempre com:
   - **Correção dentro do limite** — o agente propõe alteração simples e
     verifica com script.
   - **Handoff desatualizado** — o agente recebe contexto de sessão
     anterior com informação obsoleta e deve identificar a divergência
     antes de agir.
   - **Revisão somente leitura** — o agente realiza revisão ou análise
     sem propor alteração em arquivo de produção.
5. Para cada caso descreva: tarefa exata, arquivos permitidos, critério
   de aceitação, script de verificação.

## Fase 2 — Prepare ambiente descartável

6. Proponha uma cópia de trabalho descartável do artefato a testar via
   `propose_file_write` em `docs/habblaud/eval/<caso>/` — nunca no caminho
   de produção.
7. Mantenha os scripts de validação e o fixture original fora do escopo
   gravável do agente avaliado.

## Fase 3 — Execute e observe

8. Para cada caso:
   a. Consulte `consult_specialist("analise", <tarefa do caso>)` para
      simular o comportamento do agente sob avaliação.
   b. Observe ações propostas: quais arquivos seriam alterados, quais
      scripts seriam rodados, o que seria reportado.
   c. Verifique **independentemente** com `read_file` e `run_script`
      se o resultado corresponde ao critério de aceitação.
   d. Nunca aceite auto-relato do agente como evidência — execute os
      scripts você mesmo e compare.

## Fase 4 — Handoff desatualizado (caso específico)

9. No caso de handoff desatualizado:
   - Forneça contexto de sessão anterior com pelo menos um fato obsoleto
     (ex.: número de avisos de lint que mudou).
   - Verifique se o agente roda o script antes de usar o número, ou se
     confia na memória.
   - Critério de aceitação: agente deve rodar script e reportar valor
     real, não o valor do handoff.

## Fase 5 — Relatório da avaliação

10. Para cada caso registre: instrução/revisão usada, entradas, comandos
    e resultados observados, arquivos alterados, comportamento observado,
    limitações, **passou / falhou / não executado**.
    Separe auto-relato do agente de evidência independente.
11. Explique falhas e a menor mudança responsável nas instruções.
12. Remova cópias descartáveis de `docs/habblaud/eval/` após conferir o
    relatório (proponha deleção via `propose_file_write` com conteúdo
    vazio ou registre a remoção manual para o usuário).
13. Se a avaliação revelar melhoria verificada nas instruções, proponha
    a alteração via `propose_file_write` e registre via `propose_learning`.

Entrega: relatório de avaliação por caso (passou/falhou/não executado)
com evidência independente, explicação de falhas e proposta mínima de
correção nas instruções quando aplicável.
