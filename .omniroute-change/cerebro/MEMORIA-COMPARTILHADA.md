# Memória compartilhada dos projetos

O Cérebro (`I:/CarecaBrain/CarecaBrain`) é a base consolidada de conhecimento do usuário, comum a todas as IAs. O VS Code é a central de trabalho. A ponte MCP está disponível no VS Code, Codex, Antigravity e Claude. O OmniRoute fornece modelos; não é a memória e não intercepta chats.

## Ao iniciar e retomar trabalho

1. Identifique o projeto pelo workspace e pelo pedido. Use `cerebro_buscar` com a tarefa e o projeto; depois `cerebro_rotear` para identificar processos e especialistas existentes.
2. Leia as notas relevantes com `cerebro_ler_nota`. Reaproveite decisões, padrões, código e aprendizados antes de propor algo novo. Confira a data e as evidências; registros podem estar desatualizados. Não pergunte de novo o que a base já responde.
3. Em qualquer sessão (VS Code, Codex, Antigravity ou Claude), use os agentes existentes conforme o escopo: `aprimorador` (Claude refina a demanda) para triagem, `pesquisador` para contexto, `executor` para implementação, `revisor` para validação independente e `revisor-seguranca` para riscos. O agente `coordenador` coordena. Delegue tarefas independentes com arquivos e critérios claros; evite que dois agentes editem o mesmo arquivo. Os especialistas dos 18 departamentos continuam disponíveis pelo roteador (no Habblaud, como `chefe-<área>`).
5. Nomes de agentes e combos seguem a função, com o alvo específico no fim: `executor-codex`, `revisor-seguranca`, `processador-privado-local`, `gerente-jarvis`, `chefe-marketing-vendas`. Os nomes antigos de combo (`exec-*`, `seguranca`, `local-privado`, `jarvis`) ainda respondem no OmniRoute como apelidos ocultos, só por compatibilidade: não os use em nada novo.
4. Inclua nas delegações o projeto, as notas relevantes, decisões anteriores e o resultado esperado. Peça ao subagente aprendizados candidatos com evidência; o agente principal consolida uma vez após revisar.

## Seleção de especialistas e modelos

- Passe a `cerebro_rotear` uma descrição concreta com projeto, domínio, stack e tipo de trabalho. Os resultados são candidatos ranqueados, não uma ordem automática: confira `tipo`, `setor` e `faz` contra o pedido; descarte correspondências genéricas ou de outro domínio. Termos ambíguos como “entrega”, “integração” e “roteamento” não devem sobrepor evidência explícita do domínio.
- Fluxo vigente: o Jarvis (combo `gerente-jarvis`, modelo local) é o gerente no Habblaud e na voz; nas sessões (VS Code, Codex) quem coordena é o combo `orquestrador` (nuvem com failover até o local, nunca para por falta de token); o Claude (`aprimorador`) refina a demanda; executores por provedora `executor-claude`, `executor-codex`, `executor-antigravity`, `executor-copilot` (todos com failover); revisor de outra provedora debate; o usuário dá a palavra final. Para consulta de modelo via `cerebro_consultar`, escolha o combo pela entrega: código/debug/testes → `codigo` ou `codigo-pesado`; revisão → `revisor`; segurança → `revisor-seguranca`; pesquisa/análise → `analise` ou `contexto-longo`; texto → `texto`; arquitetura difícil → `complexo` ou `maximo`; tarefa simples → `rapido`; dado sensível → `processador-privado-local`.
- Implementação usa `executor` junto ao especialista do domínio; revisão independente usa `revisor`; envolva `revisor-seguranca` em autenticação, dados, rede, arquivos, dependências, segredos ou IA. OmniRoute consulta modelos; as ferramentas e alterações continuam sob o agente da sessão atual.

## Ao concluir uma etapa ou antes de encerrar

Use `cerebro_registrar` quando houver conhecimento reutilizável verificado. Informe `projeto`, `origem` (ex.: vscode-codex), `id` estável da sessão/etapa, `tipo` (decisao/aprendizado/entrega/handoff), `titulo`, `resumo` e `evidencias` (arquivos, testes, decisão explícita do usuário). Registre objetivo, decisão e motivo, o que foi validado e pendências relevantes. Busque antes para evitar duplicatas.

Exemplo: “O projeto Aurora usa fuso America/Sao_Paulo no faturamento porque o usuário confirmou essa regra; teste X validou a virada do dia.” Não registre “a IA sugeriu usar UTC” como decisão aprovada. Hipóteses e rascunhos não viram fatos. Correções geram nota nova citando e substituindo explicitamente a anterior; nunca apague histórico ou renomeie notas.

As notas são salvas em `conhecimento/sessoes-compartilhadas/` e encontradas imediatamente por todos os clientes conectados. Conhecimento de projetos antigos continua no mesmo vault, acessível pela busca. Não copie transcrições completas. Nunca grave chaves, tokens ou segredos. Dados sensíveis permanecem locais; envie a modelos somente o contexto necessário e autorizado.

## Evidência antes de "pronto"

- Separe três estados: **presente** (o arquivo existe), **configurado** (está completo) e **testado** (a integração rodou e respondeu). Relate cada verificação com o comando e o resultado real. O que não rodou é "não executado", nunca "passou"; falhas que já existiam continuam visíveis.
- Não enfraqueça teste, regra de lint ou permissão para obter verde. Regra nova em código legado entra medida e gradual.
- Revisão proporcional ao risco: mudança não trivial recebe revisão independente do diff exato e dos chamadores, contratos e testes ligados. Nova rodada só com evidência nova, risco em aberto ou pedido explícito.

## Trabalho em paralelo

- Toda tarefa delegada leva **Arquivos** (caminhos que vai criar ou alterar), **Recursos** (portas, pastas de build, bancos de teste, serviços, ou "nenhum") e **Depende-de**. Campo faltando ou incerto: a tarefa depende de tudo antes dela e roda em série.
- Duas tarefas só vão na mesma onda se nenhuma depende da outra, os arquivos não se cruzam e os recursos são independentes ou isolados. Worktree não isola porta nem banco.
- Um dono por arquivo; lockfile e configuração compartilhada têm dono único. Executores não fazem commit: o coordenador confere o diff, integra, roda as verificações e commita quando autorizado. Revisores paralelos só leem.
- Falha pede diagnóstico antes de nova tentativa, com limite de tentativas e escalonamento de modelo quando o risco pedir.

## Pausar, passar adiante e retomar

- Trabalho inacabado que outra sessão ou outra IA vai continuar vira `cerebro_registrar` com `tipo: handoff`. O resumo traz: objetivo e critério de aceite; estado verificado (data, revisão do git, mudanças locais); o que foi feito; evidência (comandos e resultados reais, separando falhas e não executados); o menor próximo passo; bloqueios e condição para destravar; recursos abertos (processos, portas, bancos temporários) e limpeza pendente; o que pode ter mudado. Sem segredos nem logs completos.
- Ao retomar, handoff e resumo anterior são contexto, não prova. Confira arquivos, git, verificações e processos reais antes de continuar e faça só o restante autorizado. Ao concluir, registre a entrega citando o handoff.

## Acesso e limites

Preferir MCP `cerebro`. Se a sessão ainda não carregou o MCP, usar:

```
node I:/Cerebro/cerebro-cli.mjs cerebro_buscar "projeto e tarefa"
node I:/Cerebro/cerebro-cli.mjs cerebro_rotear "tarefa"
node I:/Cerebro/cerebro-cli.mjs cerebro_registrar --arquivo caminho-do-resumo.json
```

Respeite as permissões e instruções do ambiente; não contorne aprovação. Indisponibilidade deve ser relatada, sem fingir que consultou ou registrou. Perguntas triviais não exigem chamada de modelo, delegação ou nota. `cerebro_consultar` consulta um combo OmniRoute quando útil; não executa ferramentas. Os agentes do chat realizam as ações e mantêm suas permissões. A configuração não muda automaticamente o modelo de todos os chats. Navegadores e ambientes isolados sem acesso local precisam de conector próprio.

Este é aprendizado por memória externa compartilhada, sem retreinamento dos modelos. O registro depende do agente seguir este ciclo e chamar a ferramenta; não há captura invisível de todos os aplicativos.
