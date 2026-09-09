# ADR 037 — propostas de orquestração revisáveis e locais

## Contexto

O Modo Livre já tem scheduler, templates, contexto imutável, controles manuais e
Policy Engine. Converter um objetivo diretamente em uma `workflow_run` criaria um
caminho paralelo de execução e permitiria que uma interpretação automática
escolhesse equipe, permissões ou workflow sem revisão humana.

## Decisão

- Um objetivo cria somente uma proposta persistida em SQLite, no workspace
  existente. A proposta inclui entendimento, perguntas, materiais, equipe,
  dependências, permissões solicitadas, gates, riscos, estimativas e nível de
  autonomia.
- Propostas começam em `draft`. Podem ser revisadas apenas enquanto são rascunho
  e usam `revision` otimista; revisão concorrente falha em vez de sobrescrever o
  estado observado por outra pessoa.
- Criar, editar, aprovar e rejeitar registra um evento local imutável. A autoria
  desta primeira superfície é `local-user`; nenhuma identidade de agente pode
  criar, alterar ou aprovar uma proposta pela CLI.
- Aprovar ou rejeitar altera apenas o estado auditável. A materialização posterior exige uma
  confirmação explícita, descrita no ADR 038; a aprovação sozinha não cria `workflow_run`,
  comando de run, worktree, sessão, equipe ou permissão nova.
- `compasso proposal` usa o mesmo store e as mesmas migrations que o desktop.
  Não expõe paths, SQL, comandos ou executáveis.

## Consequências

Há uma fronteira explícita entre planejamento revisável e execução. A materialização
do ADR 038 usa exclusivamente os templates, contexto, Policy Engine e scheduler
existentes, comprovando os gates e sem elevar permissões. A CLI e o primeiro painel
desktop editam objetivo e entendimento; o painel desktop também configura o template,
agente executor, permissões solicitadas e nível de autonomia antes da aprovação.
