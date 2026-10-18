---
id: ondas-paralelas
titulo: Execução em ondas paralelas
resumo: Divide lista de tarefas em ondas com arquivos disjuntos e despacha especialistas em paralelo com segurança.
modo: escrita
combos: codigo, codigo-pesado, revisor
---

> Ferramentas disponíveis: list_files, search_text, read_file,
> propose_file_write, run_script, consult_specialist, propose_learning.
> Limite: 12 etapas por tarefa — ondas numerosas viram tarefas separadas.

Substitua **[LISTA DE TAREFAS]** pela lista, plano ou épico a dividir.

## Fase 1 — Liste cada tarefa

1. Para cada unidade de trabalho registre:
   - **ID** — curto e estável (T01, T02, …).
   - **Descrição** — uma linha.
   - **Arquivos** — todo caminho/glob que será criado ou modificado.
     Na dúvida, liste mais, não menos.
   - **Depende de** — IDs de tarefas cujo output esta tarefa precisa,
     ou "nenhuma".
   - **Combo responsável** — especialista que vai executar
     (`codigo`, `codigo-pesado`, `revisor`, etc.).
2. Tarefa com **Arquivos** ou **Depende de** incertos recebe
   `Depende de: tudo já listado` — padrão seguro, não atalho.

## Fase 2 — Agrupe em ondas

3. Duas tarefas vão na **mesma onda** somente se TODAS as condições
   forem verdadeiras:
   1. Nenhuma depende da outra (direta ou transitivamente).
   2. Seus conjuntos de **Arquivos** são completamente disjuntos.
   3. Recursos mutáveis são independentes ou explicitamente isolados.
4. Se qualquer condição falhar ou for incerta, coloque a tarefa
   dependente em onda posterior. Onda de uma tarefa só é correto,
   não falha do agrupamento.
5. Apresente o resultado como tabela: número da onda, IDs, combo por
   tarefa. **Aguarde aprovação** antes de executar.

## Fase 3 — Execute cada onda em ordem

6. Para cada onda:
   a. **Despache todos os implementadores da onda de uma vez** via
      `consult_specialist` (até 4 consultas paralelas por tarefa do
      Estúdio). Cada consulta recebe: ID, descrição, arquivos exatos,
      armadilhas conhecidas, critério de verificação.
   b. Cada especialista propõe alterações; o orquestrador (você, agente
      principal) aplica via `propose_file_write` — um arquivo por vez,
      em ordem fixa.
   c. Após todas as propostas da onda aplicadas e aprovadas, rode
      `run_script("typecheck")`, `run_script("test")` e
      `run_script("lint")`.
   d. Despache revisores via `consult_specialist("revisor", <contexto>)`
      para cada tarefa da onda, em paralelo.
   e. Só avance para a próxima onda após verificação e revisão
      completas da onda atual.

## Armadilhas (copie para cada brief de especialista)

7. Liste riscos concretos do projeto antes de despachar:
   - Arquivo compartilhado que parece disjunto mas importa o outro.
   - Tipo inferido que muda com a extração.
   - Script de build que lê glob e pega arquivos novos inesperadamente.

Entrega: tabela de ondas aprovada, propostas de arquivo aplicadas onda
a onda, resultado de scripts por onda e relatório de revisão independente.
