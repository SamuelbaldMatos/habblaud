---
id: reduzir-avisos
titulo: Redução de avisos de lint
resumo: Zera avisos de uma regra (ou do conjunto) sem silenciar lint nem esconder dívida técnica.
modo: escrita
combos: codigo, revisor
---

> Ferramentas disponíveis: list_files, search_text, read_file,
> propose_file_write, run_script, consult_specialist, propose_learning.
> Limite: 12 etapas por tarefa — divida em várias tarefas se necessário.

## Fase 0 — Contagem real agora

1. Execute `run_script("lint")` e registre a contagem atual: total de
   avisos, quebrado por regra e por arquivo.
   Nunca reutilize número de execução anterior ou de memória.

## Fase 1 — 🔴 Decisão obrigatória antes de qualquer código

2. Identifique a regra ou grupo de arquivos que representa o maior risco
   (ex.: regra com 80 % dos avisos concentrada em arquivos gerados ou
   legados). Informe: quantidade de arquivos, linhas estimadas, impacto.
3. Apresente as opções ao usuário e **aguarde resposta**:
   - **(A) Corrigir todas as violações** — padrão se não houver resposta.
   - **(B) Corrigir a maioria, rastrear o restante como dívida explícita**
     (comentário + referência de tarefa, nunca supressão silenciosa).
   - **(C) Reduzir o escopo da regra na configuração** ⚠️ — isto é uma
     mudança de configuração, não limpeza de código; diga isso claramente.
   - Tudo fora da área de risco segue independentemente da opção escolhida.

## Fase 2 — Critérios de sucesso (comandos, não prosa)

4. Liste cada critério como script a rodar e resultado esperado:
   - `lint` → 0 avisos para a regra alvo (ou contagem acordada).
   - `typecheck` → sem erros.
   - `test` → verde.
   - `build` → compila.
   - Nenhuma mudança de comportamento: qualquer correção não mecânica vira
     item separado para revisão humana.

## Fase 3 — Ondas de trabalho

5. Agrupe violações em ondas com **arquivos disjuntos** (sem sobreposição).
   Para cada tarefa de cada onda: ID, arquivos exatos, dependências, combo
   responsável.
   Se o número de ondas exceder o limite de etapas da tarefa atual,
   registre o plano e divida em tarefas menores antes de executar.

## Fase 4 — Armadilhas (copie para cada brief de onda)

6. Liste cada risco concreto desta regra neste projeto — ex.: cache de
   lint que não invalida ao mudar configuração, extração que alarga tipo
   inferido, fixture de teste com muitos chamadores.
   Um agente especialista vê apenas seu próprio brief; armadilha não
   copiada não existe para ele.

## Fase 5 — Revisão independente

7. Ao final de cada onda, consulte `consult_specialist("revisor", <diff>)`
   para revisão independente antes de considerar a onda concluída.
   Para arquivos com lógica de segurança, use `"revisor-seguranca"`.

## Fase 6 — Checklist final (marque apenas rodando)

8. Rode cada script novamente; marque somente após execução real:
   - [ ] `lint` → contagem acordada
   - [ ] `typecheck` → limpo
   - [ ] `test` → verde
   - [ ] `build` → compila
   - [ ] Toda supressão adicionada está listada com justificativa
   - [ ] Toda correção não mecânica está listada e aprovada
   - [ ] Revisões independentes concluídas

Entrega: contagem de avisos antes/depois verificada por script, lista de
supressões justificadas e lista de itens não mecânicos para revisão humana.
