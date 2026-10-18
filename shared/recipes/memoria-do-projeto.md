---
id: memoria-do-projeto
titulo: Memória persistente do projeto
resumo: Cria sistema de dois níveis para preservar decisões e aprendizados entre sessões do Estúdio.
modo: escrita
combos: contexto-longo, analise
---

> Ferramentas disponíveis: list_files, search_text, read_file,
> propose_file_write, run_script, consult_specialist, propose_learning.
> Dado sensível (credenciais, dumps) nunca vai para arquivo de memória.

## Fase 0 — Verifique o que já existe

1. Use `list_files("docs/habblaud/memory")` para ver se a pasta
   de memória já existe.
2. Use `read_file("AGENTE.md")` (ou equivalente) para
   verificar se o índice já é referenciado no arquivo de configuração da
   sessão.
3. Registre o que está PRESENTE, o que precisa ser CONFIGURADO e o que
   ainda não foi TESTADO.

## Fase 1 — Nível 1: índice sempre carregado

4. Proponha `docs/habblaud/memory/INSTRUCOES.md` com as regras
   abaixo (conteúdo completo via `propose_file_write`):
   - Critério de salvamento: salve apenas o que uma sessão futura ficaria
     surpresa e grata de saber antes de começar, em vez de descobrir da
     forma difícil.
   - Não salvar: derivável do código, prazo, motivação temporária,
     receita de debug que pertence a commit.
   - Salvar: erro corrigido após tentativas, decisão arquitetural após
     alternativas rejeitadas, regra de negócio invisível no código,
     onde encontrar algo fora do repositório.
5. Proponha `docs/habblaud/memory/MEMORIA.md` — índice inicial
   vazio com cabeçalho e instrução de formato (uma linha por entrada,
   apontando para arquivo de tópico).
6. Referencie `INSTRUCOES.md` no arquivo de configuração da sessão
   (ex.: `AGENTE.md`) via `propose_file_write` — sem essa referência,
   o índice não é lido automaticamente.

## Fase 2 — Nível 2: armazenamento de longo prazo

7. Verifique se há pasta de documentação duradoura (`docs/`, `wiki/`,
   `docs/habblaud/knowledge/`) com `list_files`.
8. Se existir: registre localização e acesso. Se não existir: entregue
   apenas o Nível 1; não invente destino — anote a lacuna para o usuário
   decidir.

## Fase 3 — Política de crescimento

9. Defina o limite de linhas não vazias do índice (sugestão: 130).
   Proponha a seção "Política de crescimento" em `INSTRUCOES.md`:
   - Antes de adicionar entrada, conte linhas do índice.
   - Se ultrapassar o limite: avalie cada entrada (recência × especificidade
     × chance de evitar erro futuro); migre as de menor valor para o Nível 2
     **antes** de deletar — nunca delete sem confirmar a migração com
     `read_file` no destino.
   - Nunca invente data de verificação ou evidência.

## Fase 4 — Primeiro registro

10. Use `propose_learning` para registrar o próprio aprendizado de
    configurar este sistema como primeiro item verificado do Cérebro.
11. Proponha o arquivo de tópico correspondente em
    `docs/habblaud/memory/` com frontmatter:
    ```
    name, description, type, source, evidence, last_verified, invalidate_when
    ```

Entrega: estrutura de memória em dois níveis proposta e pronta para
aprovação, política de crescimento documentada, primeiro aprendizado
registrado.
