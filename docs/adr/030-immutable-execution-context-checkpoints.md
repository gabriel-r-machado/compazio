# ADR 030 — Contexto efetivo e checkpoints imutáveis

## Contexto

Antes de introduzir o scheduler, o Compasso precisa provar qual contexto foi
entregue a um agente. Consultar os dados atuais após uma execução é insuficiente:
papéis, missão, memória, artefatos e contratos podem ter novas versões.

## Decisão

- O Context Builder reúne para um agente o perfil atual versionado, missão,
  memória do workspace, fontes `context` diretamente conectadas, memória dos
  artefatos conectados, último handoff entregue e o contrato destinado ao
  agente.
- Um checkpoint de `function` ou `delivery` salva o contexto efetivo completo
  em `execution_context_snapshots`, com SHA-256 do payload, e cria um registro
  em `execution_checkpoints` que o referencia.
- Ambos os registros são append-only. A leitura valida o hash, os IDs do
  workspace/agente/tarefa e o contrato antes de devolver o snapshot.
- A CLI oferece construção e inspeção para o usuário local. Não há `--from`,
  execução de processos, acesso a paths absolutos ou autorização implícita de
  agente nesta camada.

## Consequências

O Lote D pode anexar estes checkpoints às runs sem criar outro modelo de
contexto. O custo é o armazenamento do payload completo em cada checkpoint,
aceito para garantir auditoria e reprodutibilidade locais.
