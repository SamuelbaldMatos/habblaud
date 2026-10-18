---
id: organizar-projeto
titulo: Limpeza geral do projeto
resumo: Mede avisos, código morto e dependências não usadas antes de qualquer alteração, depois age em passos verificáveis.
modo: escrita
combos: codigo, revisor
---

> Ferramentas disponíveis: list_files, search_text, read_file,
> propose_file_write, run_script, consult_specialist, propose_learning.

## Fase 0 — Verdade atual (meça antes de agir)

1. Execute `run_script("lint")` e anote contagem real de avisos por arquivo.
2. Execute `run_script("typecheck")` e anote erros.
3. Execute `run_script("test")` e anote resultado (passou / falhou / N testes).
4. Execute `run_script("build")` e anote se compilou.
5. Leia `package.json` com `read_file` para identificar todas
   as dependências declaradas.
6. Se qualquer passo acima falhar, **pare** e reporte antes de continuar.
   Não limpe sobre uma base quebrada.

## Fase 1 — Inventário (encontre, não corrija ainda)

7. Use `search_text("TODO")`, depois `search_text("FIXME")` e `search_text("XXX")`
   (a busca é por texto literal, uma palavra por vez) e liste cada
   ocorrência com arquivo e linha.
8. Use `search_text` para rastrear exportações sem importadores conhecidos
   (busque o nome exportado no restante do projeto).
9. Compare dependências do `package.json` com importações encontradas via
   `search_text`; liste as que não aparecem em nenhum arquivo fonte.
10. Consolide: (a) código morto provável, (b) marcadores TODO/FIXME,
    (c) dependências possivelmente não usadas.

## Fase 2 — Plano priorizado

11. Divida os achados em dois grupos e apresente ao usuário antes de agir:
    - **Grupo 1 — seguro por padrão:** importações não usadas, arquivos
      sem referências, TODOs de trabalho já concluído.
    - **Grupo 2 — precisa de aprovação:** qualquer "não usado" ambíguo
      (importação dinâmica, reflexão, API pública), remoção de dependência
      que pode ser peer-dep, TODO que documenta limitação real conhecida.
    - Se o usuário não responder, prossiga **apenas** com o Grupo 1.

## Fase 3 — Execução em passos pequenos

12. Para cada item do grupo aprovado, um de cada vez:
    a. Proponha a alteração via `propose_file_write` com conteúdo completo.
    b. Após aprovação, rode o script específico (`lint` ou `typecheck` ou
       `test`) que prova a correção — não a suite inteira de memória.
    c. Só avance ao próximo item após confirmação do passo anterior.

## Fase 4 — Relatório final

13. Execute novamente lint, typecheck, test e build.
14. Mostre números antes × depois lado a lado.
    Nunca escreva "corrigido" sem o output do script que prova.
15. Se houver aprendizado verificado (ex.: padrão de importação dinâmica
    que confunde o linter), proponha via `propose_learning`.

Entrega: relatório antes/depois com números reais, lista de alterações
aplicadas e lista de itens do Grupo 2 aguardando decisão futura.
