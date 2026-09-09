# ADR 036 — nó de handoff do workflow prepara somente rascunhos revisáveis

## Contexto

O scheduler já possuía executor de agente, shell, qualidade e artefato, mas
uma entrega entre agentes ainda precisava começar pelo lifecycle visual de
handoff. Transformar esse passo em envio automático violaria a política local
de revisão humana.

## Decisão

- Um nó `handoff` obtém o agente de origem da associação imutável da run e
  resolve exatamente uma conexão visual cujo contrato seja do tipo `handoff`.
- O executor cria somente um `draft` persistido. A rota ambígua, ausente ou a
  permissão `create_handoffs` ausente fazem o nó falhar fechado.
- A evidência da run contém apenas o ID opaco e o estado `draft`. Não contém
  caminho, terminal, comando ou conteúdo de entrega.
- Aprovação, rejeição, envio ao terminal, confirmação e retry continuam usando
  o lifecycle manual de handoff existente. Nenhum workflow pode entregar ou
  confirmar uma entrega automaticamente.

## Consequências

Workflows podem agora registrar uma passagem de trabalho na mesma projeção do
canvas, com política e auditoria comuns. O handoff permanece revisável e o
controle humano continua sendo necessário antes de qualquer ação externa.
