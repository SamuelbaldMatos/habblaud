---
id: ideia-ao-plano
titulo: Da ideia ao plano executável
resumo: Transforma pedido vago em plano passo a passo com critério de verificação antes de escrever qualquer código.
modo: escrita
combos: complexo, codigo
---

> Ferramentas disponíveis: list_files, search_text, read_file,
> propose_file_write, run_script, consult_specialist, propose_learning.

Substitua **[PEDIDO]** pelo texto exato do pedido — quanto mais cru e
ambíguo, melhor; não refine antes de colar.

## Fase 1 — Clarificar intenção (não implemente ainda)

1. Leia os arquivos relevantes do `{{workspace}}` com `read_file` /
   `list_files` para entender o contexto atual.
2. Elabore perguntas curtas e diretas para fixar:
   - O que "pronto" significa para este pedido.
   - O que está explicitamente dentro e fora do escopo.
   - Restrições não declaradas mas prováveis (padrões existentes,
     compatibilidade, performance).
3. Se o pedido for genuinamente ambíguo (mais de uma interpretação
   razoável), apresente as interpretações lado a lado em vez de escolher
   silenciosamente uma. Se já estiver claro, pule as perguntas — não
   interrogue pedido óbvio.
4. **Aguarde resposta do usuário** antes de prosseguir.

## Fase 2 — Transformar em plano

5. Com o escopo confirmado, escreva um plano passo a passo.
   Cada passo recebe um **critério de verificação** explícito:
   - script a rodar (`lint`, `typecheck`, `test`, `build`), ou
   - comportamento observável a confirmar, ou
   - arquivo a inspecionar com `read_file`.
   - Passo sem forma de verificar = passo vago; quebre em partes menores.
6. Estime quantas etapas do Estúdio serão necessárias. Se ultrapassar 12,
   divida em tarefas menores e indique a ordem antes de continuar.

## Fase 3 — Confirmação leve

7. Mostre o plano completo e aguarde confirmação (um "pode seguir" ou
   correção específica). Plano que muda após feedback é esperado; reconfirme
   apenas as partes alteradas.

## Fase 4 — Implementar contra o plano

8. Para cada passo, em ordem:
   a. Proponha a alteração via `propose_file_write` (conteúdo completo).
   b. Após aprovação, rode o script de verificação daquele passo.
   c. Mostre o resultado antes de marcar o passo como concluído.
   d. Se a verificação falhar, corrija antes de avançar — nunca construa
      sobre fundação não verificada.
9. Ao concluir, rode `run_script("test")` e `run_script("build")` como
   verificação final de integração.

Entrega: plano confirmado pelo usuário + implementação passo a passo com
cada verificação executada e resultado mostrado.
