---
id: quebrar-arquivos-grandes
titulo: Quebrar arquivos grandes
resumo: Divide arquivos acima do limite de linhas em módulos menores por responsabilidade, preservando a interface pública.
modo: escrita
combos: codigo, revisor
---

> Ferramentas disponíveis: list_files, search_text, read_file,
> propose_file_write, run_script, consult_specialist, propose_learning.
> Uma quebra por vez; arquivos do lote: 3 (ajuste se necessário).

## Fase 0 — Lista real dos arquivos acima do limite

1. Execute `run_script("lint")` e liste todos os arquivos reportados pela
   regra de tamanho (ex.: `quality/max-lines`), com contagem real de
   linhas, ordenados do maior para o menor.
   Nunca use contagem de memória ou de execução anterior.
2. Reporte essa lista antes de tocar qualquer arquivo.

## Fase 1 — Escolha o lote (padrão: 3 maiores)

3. Pegue os 3 maiores arquivos (ou o número definido pelo usuário).
   Para cada um, antes de editar, declare:
   - Responsabilidade atual do arquivo (uma frase).
   - Costuras encontradas e qual será cortada.
   - Exportações públicas (nomes que outros arquivos importam).

## Fase 2 — Onde cortar (por responsabilidade, nunca por linha)

4. Procure costuras nesta ordem de preferência:
   - Lógica de negócio misturada em arquivo de UI ou rota →
     módulo de serviço/caso de uso.
   - Bloco de UI repetido → subcomponente reutilizável.
   - Acesso a dados (queries, ORM) → repositório ou adaptador.
   - Cluster de utilidades que serve apenas um conceito →
     módulo utilitário de domínio.
5. Se o arquivo não tiver costura natural (implementação genuinamente
   coesa), diga isso, deixe-o intocado e passe para o próximo.
   Relatar "sem costura natural" é resultado válido — não invente
   abstração só para satisfazer o linter.
6. Nunca nomeie o novo arquivo `helpers.ts`, `utils.ts`, `misc.ts` ou
   `common.ts` com sobras aleatórias.

## Fase 3 — Preserve a interface pública

7. Após a quebra, as exportações públicas do arquivo original devem
   continuar existindo com os mesmos nomes e assinaturas.
   Prefira deixar o arquivo original como módulo fino que re-exporta dos
   novos em vez de editar todos os sites de importação.
8. Reescrever sites de importação só é permitido quando o arquivo original
   vai desaparecer por completo — e somente se dito explicitamente antes.

## Fase 4 — Um arquivo por vez

9. Para cada arquivo do lote, em ordem:
   a. Proponha os novos arquivos via `propose_file_write` (conteúdo
      completo de cada um).
   b. Proponha o arquivo original atualizado (re-exportações ou remoção).
   c. Após aprovação, execute `run_script("typecheck")`.
   d. Execute `run_script("test")`.
   e. Execute `run_script("lint")` e confirme que o arquivo não aparece
      mais na lista E que nenhuma nova violação surgiu em outro lugar.
   f. Só avance ao próximo arquivo após todos os scripts passarem.
   g. Se qualquer script falhar, corrija antes de avançar.

## Fase 5 — Pare e reporte

10. Após o lote, pare. Não continue para o próximo lote por conta própria.
11. Reporte:
    - Arquivos quebrados e costura usada em cada um.
    - Arquivos intencionalmente não quebrados e motivo.
    - Output de `run_script("lint")` rodado uma última vez: quantos
      arquivos ainda estão acima do limite e seus nomes.
    - Qualquer violação de outra regra que surgiu como efeito colateral.
12. Se houver aprendizado verificado sobre padrão de extração deste
    projeto, proponha via `propose_learning`.

Entrega: arquivos do lote quebrados (ou justificadamente intocados),
scripts passando, relatório de arquivos restantes acima do limite.
