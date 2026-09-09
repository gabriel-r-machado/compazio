# ADR 028 — packs versionados de identidade, missão e memória

Status: aceito

## Contexto

As roles e a missão já existiam no canvas, mas não havia uma versão imutável que pudesse provar qual
identidade, objetivo e conhecimento do workspace eram válidos em uma execução futura. Alterar o
canvas não pode reescrever o contexto já usado por uma entrega.

## Decisão

O SQLite passa a manter três coleções append-only por workspace:

- `agent_profiles`: identidade, adapter, responsabilidades, limites, capacidades e entregas esperadas
  de cada nó de agente;
- `missions`: objetivo, escopo, decisões, restrições, progresso e bloqueios;
- `workspace_memories`: stack, arquitetura, padrões, comandos convencionados, convenções e decisões
  técnicas.

O perfil é uma projeção versionada da role e das permissões já configuradas no canvas. Não há comando
para um agente declarar ou ampliar suas próprias capacidades. Quando a role visual muda, a primeira
consulta de perfil cria um novo snapshot sem alterar as versões anteriores.

`compasso mission set` também atualiza a missão compatível do canvas e grava uma versão detalhada. Se
o usuário editar somente a missão no canvas, a próxima consulta materializa uma nova versão que
preserva os demais campos. `compasso memory set` cria sempre uma versão nova. Os comandos não aceitam
`--from`: são ações do usuário local e não expõem filesystem, executáveis, argumentos, cwd ou SQL.

## Consequências

- execuções futuras poderão referenciar versões exatas de identidade, missão e memória;
- mudanças no canvas continuam compatíveis, mas não reescrevem evidência histórica;
- o Lote C pode construir checkpoints imutáveis sobre esses packs, sem iniciar scheduler ou autonomia.
