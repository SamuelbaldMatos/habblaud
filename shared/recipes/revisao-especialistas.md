---
id: revisao-especialistas
titulo: Revisão por painel de especialistas
resumo: Despacha múltiplos revisores independentes em paralelo e sintetiza achados ranqueados por severidade.
modo: leitura
combos: codigo, revisor, revisor-seguranca
---

> Ferramentas disponíveis: list_files, search_text, read_file,
> propose_file_write, run_script, consult_specialist, propose_learning.
> Dado sensível nunca vai a combo de nuvem.

## Fase 0 — Delimite o alvo

1. Use `read_file` nos arquivos alterados (ou `list_files` + `read_file`
   para uma pasta específica) para montar o contexto da revisão.
   Registre: arquivos inspecionados, escopo incluído e excluído.

## Fase 1 — Despacho paralelo (até 4 consultas por tarefa)

2. Envie o mesmo conjunto de arquivos para cada lente relevante via
   `consult_specialist`, escolhendo apenas as que se aplicam à mudança:
   - **Qualidade geral** (`"codigo"`) — legibilidade, tratamento de erros,
     código morto, cobertura de testes ausente.
   - **Segurança** (`"revisor-seguranca"`) — OWASP Top 10, segredos
     expostos, injeção, autenticação quebrada.
     ⚠️ Não envie dados sensíveis reais; descreva o padrão, não o valor.
   - **Tipagem / TypeScript** (`"revisor"`) — asserções inseguras, escape
     do sistema de tipos, corretude de async/concorrência.
   - **Framework / domínio** (`"codigo-pesado"`) — apenas se a mudança
     toca código específico de framework (ex.: hooks React, rotas Next.js).
   - Cada consulta deve pedir: `"arquivo:linha — severidade — afirmação em
     uma frase — cenário concreto de falha"`. Achado sem cenário concreto
     não é achado — o especialista deve descartá-lo.

## Fase 2 — Síntese

3. Após receber todos os retornos:
   a. **Deduplicar** — mesmo problema apontado por mais de um especialista
      vira uma entrada; mantenha a descrição mais precisa e note quem
      concordou.
   b. **Filtrar** — descarte qualquer achado sem cenário de falha concreto
      ou já tratado em outro ponto do código. Verifique antes de descartar.
   c. **Ranquear** — CRÍTICO (segurança/perda de dados) → ALTO (bug real)
      → MÉDIO (manutenibilidade) → BAIXO (estilo).

## Fase 3 — Relatório

4. Apresente um único relatório, do mais severo ao menos severo.
   Cada entrada: arquivo:linha, resumo, cenário de falha, severidade,
   quais especialistas apontaram.
5. Se nenhum achado sobreviver à síntese, diga isso claramente — lista
   vazia em CRÍTICO/ALTO é resultado válido, não falha.
6. Inclua: escopo revisado, escopo não revisado, riscos residuais.
7. Não aplique correções automaticamente; liste-as para aprovação.
8. Se houver aprendizado verificado (ex.: padrão recorrente de bug),
   proponha via `propose_learning`.

Entrega: relatório ranqueado por severidade com achados deduplicados,
escopo coberto e lista de correções sugeridas aguardando aprovação.
