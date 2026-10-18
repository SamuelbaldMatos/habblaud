---
id: revisao-seguranca
titulo: Revisão de segurança
resumo: Análise de segurança baseada em evidências do código-fonte; somente leitura, sem aplicar correções automaticamente.
modo: leitura
combos: revisor-seguranca, revisor
---

> Ferramentas disponíveis: list_files, search_text, read_file,
> propose_file_write, run_script, consult_specialist, propose_learning.
> ⚠️ Dado sensível (credenciais, dumps, PII) nunca vai a combo de nuvem.
> Esta receita é somente leitura — não aplica correções automaticamente.

## Fase 0 — Estabeleça o alvo reproduzível

1. Registre: data da revisão, pasta raiz `{{workspace}}`, stack e runtime
   (leia `package.json` e arquivos de configuração relevantes com
   `read_file`).
2. Liste os arquivos em escopo com `list_files`; exclua pastas de cache,
   node_modules, dumps e diretórios não relacionados.
3. Registre o escopo inspecionado e o excluído antes de continuar.

## Fase 1 — Modelo de ameaça compacto

4. Use `read_file` nos arquivos de entrada (rotas, controllers, middleware)
   para identificar: ativos valiosos, pontos de entrada expostos, papéis
   de usuário, fluxos de dados sensíveis e proteções existentes.
5. Consulte `consult_specialist("revisor-seguranca", <contexto>)` com o
   mapa de ameaças (sem valores reais de segredos — descreva tipo e
   localização).
   ⚠️ Se o arquivo contiver credenciais reais, descreva localização e
   tipo; nunca envie o valor.

## Fase 2 — Rastreio de entrada não confiável

6. Use `search_text` para localizar pontos de entrada (ex.: `req.body`,
   `req.params`, `req.query`, `process.env`) e rastreie até operações
   sensíveis: queries, shell, templates, serialização.
7. Para cada caminho encontrado, verifique se há validação, autorização
   e tratamento de falha — inspecione com `read_file`.
8. Verifique áreas relevantes (apenas as aplicáveis ao projeto):
   - Autenticação, sessões, recuperação de conta, autorização por papel/
     objeto, isolamento entre tenants.
   - Ciclo de vida de segredos: exposição em bundles cliente, logs, erros,
     exemplos, CI.
   - Injeção: queries, comandos shell, templates, HTML no browser,
     deserialização, execução dinâmica.
   - Caminhos de arquivo, upload, extração de arquivos comprimidos, SSRF.
   - Proteção de dados, criptografia, limites de recurso, condições de
     corrida em estado concorrente.
   - Dependências: verifique versões no `package.json`; relate versões
     com CVE conhecida (não prove exploração automaticamente).

## Fase 3 — Para cada candidato a achado

9. Estabeleça: entrada controlada pelo atacante, privilégios necessários,
   caminho de chamada alcançável, controle ausente ou bypassável,
   impacto concreto.
10. Busque contra-evidência: validação upstream, verificação de propriedade,
    restrições de deploy, testes existentes.
11. Separe: achados confirmados, hipóteses plausíveis que precisam de
    validação, sugestões de hardening.

## Fase 4 — Relatório

12. Produza relatório com seções:
    1. **Escopo:** data, modo, arquivos revisados, suposições de
       autorização, ativos e fronteiras de confiança.
    2. **Cobertura:** caminhos revisados e excluídos, ferramentas usadas,
       capacidades indisponíveis.
    3. **Achados** ordenados por impacto: ID/título, severidade
       (crítico/alto/médio/baixo) e racional, confiança, arquivo/linha,
       evidência redatada, pré-requisitos do atacante, fluxo alcançável,
       impacto concreto, contra-evidência, correção proposta estreita.
    4. **Validações pendentes** e limitações.
13. Proponha o relatório via `propose_file_write` em
    `docs/habblaud/security-reviews/<data>-revisao.md`.
    Nunca reproduza credenciais, dados pessoais ou payloads de exploit.
14. Confirm que nenhum arquivo do projeto foi alterado durante a revisão.
15. Se achado verificado revelar padrão recorrente, proponha via
    `propose_learning` (sem dados sensíveis).

Entrega: relatório de segurança salvo fora do código de produção,
ranqueado por severidade, com achados confirmados separados de hipóteses,
e lista de correções aguardando instrução separada do usuário.
