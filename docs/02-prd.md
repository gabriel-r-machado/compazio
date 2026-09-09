# PRD — Product Requirements Document

## Objetivo

Permitir que uma pessoa transforme um objetivo e materiais locais em uma entrega de software
coordenada, verificável e recuperável, montando um time de agentes em um canvas ou pedindo que uma IA
já instalada proponha esse time.

## Público inicial

- pessoas que já usam shell, Claude Code ou Codex CLI;
- solo builders e pequenas equipes que constroem landing pages, SaaS, aplicativos e sistemas;
- profissionais que querem especialização multiagente sem perder os terminais reais;
- tech leads que exigem rastreabilidade, controle de permissões e checks reais.

## Problemas prioritários

1. Contexto repetido manualmente entre agentes e janelas.
2. Workflows especializados difíceis de montar e impossíveis de reutilizar.
3. Automação frágil baseada em digitação no terminal e leitura de output.
4. Falta de clareza sobre responsabilidade, entrada, entrega e conclusão.
5. Multiagente que aumenta custo e produz resultados inconsistentes.
6. Falhas silenciosas, sessões perdidas e baixa confiança para outras pessoas usarem.

## Proposta de valor

O usuário organiza uma operação inteira no canvas sem precisar projetar infraestrutura de agentes.
Ele enxerga terminais reais, materiais e estado; o Compasso cuida de contratos, contexto,
dependências, políticas, persistência, validação e recuperação.

## Capacidades do produto-alvo

### P0 — ciclo confiável

- abrir e persistir projeto, canvas e terminais locais;
- montar time manualmente com poucos campos obrigatórios;
- conectar materiais, agentes e validações com semântica explícita;
- executar um workflow aprovado por scheduler determinístico;
- passar contexto e artefatos estruturados entre etapas;
- acompanhar, pausar, assumir, cancelar e retomar;
- validar o resultado com gates aplicáveis;
- explicar falhas e recuperar etapas seguras;
- salvar e reutilizar o workflow.

### P1 — composição assistida

- escolher um agente-capitão entre os runtimes disponíveis;
- enviar objetivo, materiais, capabilities, políticas e perfil;
- permitir que o capitão componha um rascunho usando ferramentas estruturadas do Compasso;
- projetar o rascunho no canvas para revisão;
- preservar o canvas ao alternar Manual ↔ Com IA;
- garantir que não exista workflow genérico silencioso como fallback.

### P1 — perfis de execução

- Econômico, Padrão e Alta Performance;
- impacto real sobre quantidade de especialistas, contexto, concorrência, validação e repair loop;
- limites globais, materiais obrigatórios e permissões preservados;
- orçamento e métricas rotulados honestamente como reais ou estimados.

### P2 — memória e reutilização

- perfis de agentes;
- times salvos;
- blueprints versionados;
- memória por projeto e por marca;
- histórico de decisões aprovadas e rejeitadas;
- comparação de versões e impacto de artefatos.

## Requisitos funcionais críticos

- `RF-CANVAS-001`: terminais reais continuam interativos dentro do canvas.
- `RF-CANVAS-002`: Manual e Com IA alteram a forma de composição, não criam ambientes separados.
- `RF-CANVAS-003`: o usuário pode alternar entre as formas sem perder nós, conexões ou estado.
- `RF-AGENT-001`: somente runtimes instalados e disponíveis podem ser selecionados.
- `RF-AGENT-002`: o produto não chama modelo próprio nem armazena credencial do provider.
- `RF-PLAN-001`: o agente-capitão cria um rascunho por protocolo estruturado e autenticado.
- `RF-PLAN-002`: proposta não inicia execução antes de validação e aprovação.
- `RF-RUN-001`: scheduler, não LLM, controla o estado do workflow.
- `RF-RUN-002`: output bruto, silêncio e encerramento do PTY não comprovam conclusão.
- `RF-RUN-003`: usuário pode pausar, assumir e retomar uma execução.
- `RF-CONTEXT-001`: cada etapa recebe somente contexto permitido e relevante ao contrato.
- `RF-HANDOFF-001`: transições automáticas autorizadas em run formal são distintas de handoffs
  interativos iniciados pelo usuário.
- `RF-QUALITY-001`: sucesso exige evidência adequada ao tipo de tarefa.
- `RF-RECOVERY-001`: estado persistido permite explicar e recuperar interrupções sem fingir retomada.
- `RF-REUSE-001`: um workflow aprovado pode ser salvo e adaptado em outro projeto.

## Métricas de sucesso

- tempo até o primeiro terminal útil;
- tempo para montar e iniciar um workflow;
- porcentagem de runs que terminam sem intervenção obrigatória;
- falhas silenciosas: alvo zero;
- porcentagem de falhas com ação de recuperação compreensível;
- tokens/contexto evitados por seleção e reutilização;
- taxa de reutilização de perfis, times e blueprints;
- resultado validado por gates, não apenas declarado pelo agente;
- satisfação do usuário com controle e clareza da execução.

## Restrições

- desktop local-first e útil offline;
- Electron e arquitetura atuais preservados sem ADR;
- renderer sem acesso genérico a Node.js, shell ou filesystem;
- cloud, billing, remote control e telemetria atrás de feature flags;
- merge, deploy e ações destrutivas sob autorização explícita;
- adapter de shell falso como primeira prova dos fluxos.

## Limites da primeira entrega

- não ser uma IDE;
- não suportar todos os agentes e stacks;
- não oferecer colaboração remota em tempo real;
- não criar marketplace pago;
- não hospedar modelos;
- não prometer autonomia irrestrita;
- não chamar um workflow de concluído sem evidência.

Os critérios detalhados estão em `specs/product/requirements.md` e
`specs/product/acceptance-criteria.md`. O estado implementado está em
`docs/23-current-capabilities.md`.
