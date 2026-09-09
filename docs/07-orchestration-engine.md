# Engine de orquestração

## Objetivo

Executar workflows de forma previsível, mantendo terminais visíveis e permitindo intervenção do
usuário. O engine não depende de um LLM para saber o próximo passo.

“Manual” e “Com IA” são formas de produzir ou alterar a definição do workflow. Depois de aprovado,
ambos usam este mesmo engine.

## Modelo

Um workflow é um DAG composto por nós e arestas.

### Tipos de nó

- `agent`
- `shell`
- `human_approval`
- `quality_gate`
- `artifact`
- `transform`
- `parallel_group`
- `subworkflow`

### Estado do nó

```ts
type NodeState =
  | "pending"
  | "ready"
  | "starting"
  | "running"
  | "waiting"
  | "blocked"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "skipped";
```

## Scheduler

O scheduler:

1. valida o workflow;
2. calcula dependências;
3. marca nós elegíveis;
4. respeita limite de concorrência;
5. adquire locks de recurso;
6. executa;
7. avalia outputs;
8. aplica retry;
9. libera dependentes;
10. conclui ou bloqueia o run.

### Conclusão oficial

Um run só é `succeeded`, `failed`, `cancelled` ou `interrupted` depois que a transição terminal foi
gravada de forma durável. O snapshot em memória do scheduler nunca antecipa a conclusão: `getRun`,
`show`, a promise de conclusão e a projeção por IPC leem o mesmo estado, que só muda depois que o
store aceitou a escrita.

Pertencem à mesma transição terminal, e portanto são gravados antes da confirmação:

- estado do run e `endedAt`;
- estado e tentativa de cada nó;
- delivery checkpoint do contexto de execução;
- relatório final e seu artefato;
- evento terminal (`run.completed`, `run.failed`, `run.cancelled` ou `run.interrupted`).

Uma falha real de persistência não vira conclusão: o run permanece não terminal e o erro é
propagado.

### Encerramento

`close()` do runtime é assíncrono, idempotente e segue uma ordem explícita:

1. deixa de aceitar novos runs;
2. interrompe o que ainda está em execução, liberando waiters e aprovações pendentes;
3. drena todas as transições terminais até o banco;
4. só então o supervisor de processos e os stores são fechados.

Um run finalizando não é interrompido — o encerramento espera por ele. Um run realmente em execução
é gravado como `interrupted`, exatamente o estado que a recuperação produziria no próximo boot, de
modo que o reload não ressuscita run nem cria tentativa. Depois de fechado, o store recusa qualquer
escrita em vez de perdê-la contra um banco fechado.

## Locks

Recursos bloqueáveis:

- project;
- branch;
- worktree;
- port;
- file glob;
- environment;
- adapter session.

## Idempotência

Cada execução tem:

- `run_id`;
- `node_run_id`;
- `attempt`;
- `idempotency_key`;
- `input_hash`;
- `workflow_version`.

Um nó concluído só é reutilizado quando:

- workflow version igual;
- input hash igual;
- outputs ainda existem;
- política permite cache.

## Retries

```yaml
retry:
  max_attempts: 2
  backoff_ms: 3000
  retry_on:
    - process_exit_nonzero
    - timeout
```

Não repetir automaticamente:

- aprovação negada;
- conflito Git;
- permissão negada;
- schema inválido;
- ação destrutiva.

## Handoffs de runs formais

Um handoff contém:

```ts
interface Handoff {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  summary: string;
  decisions: Decision[];
  artifacts: ArtifactRef[];
  openQuestions: string[];
  acceptanceEvidence: Evidence[];
  schemaVersion: string;
}
```

Persistir em:

```text
.forgedeck/
  runs/<run-id>/
  handoffs/
  artifacts/
  reports/
```

Esses handoffs pertencem a `workflowRuns` e `nodeRuns` do scheduler. Sessões interativas do canvas
usam um store local separado, pois não devem inventar um run formal. Em ambos os casos, texto do
agente não prova conclusão.

### Handoff interativo do canvas

O usuário aciona **Concluir e entregar**, revisa um pacote estruturado e só então emite
`handoff_ready`. O processo principal deriva missão, papéis e contrato dos dados persistidos e
envia a entrega aprovada à sessão de destino. Encerramento do PTY nunca libera dependentes.

Estados: `draft → ready → delivering → delivered|failed`. Uma entrega encontrada em
`delivering` após crash vira `delivery_unknown` e exige decisão manual; não há retry silencioso.

## Planner opcional

Um agente-capitão instalado pelo usuário pode propor um workflow por ferramentas estruturadas do
Compasso. O produto não chama um planner próprio nem substitui falha por template genérico.

A proposta:

- deve validar contra schema;
- aparece como diff;
- exige aprovação;
- não pode ampliar permissões;
- não pode habilitar deploy/merge sozinho.

O agente-capitão coordena a composição; ele não deve executar silenciosamente a missão principal no
mesmo papel. Depois da aprovação, os workers são acionados pelos adapters e pelo scheduler.

## Modo Automático

O `AutomaticWorkflowCoordinator` transforma um objetivo em workflow gerado, executado, verificado e
autocorrigido **coordenando** as operações oficiais existentes. Ele não possui runtime, scheduler, fila
nem persistência próprios.

O ciclo:

1. o orquestrador (tarefa de análise somente leitura) devolve um `OrchestratorPlan` estruturado;
2. o plano é validado por schema e pelo orçamento de nós do modo; texto livre nunca vira workflow;
3. o plano é convertido no `WorkflowDraft` existente e precisa materializar — um ciclo no grafo,
   que o schema do plano não detecta, é recusado antes de qualquer execução;
4. nós com aprovação exigida ou risco acima de `safe` bloqueiam apenas a si mesmos;
5. o draft aprovado materializa **uma** run oficial;
6. cada nó é verificado por resultado estrutural, artefatos esperados e exit code dos comandos
   permitidos — nunca por frase final;
7. a falha produz um `RemediationPlan` validado que se torna retry oficial do nó falho ou **um** nó
   corretivo que depende dele.

### Lineage de runs

O runtime oficial nunca redispara um nó dentro de uma run viva e nunca reescreve a definição, a
evidência ou o relatório de uma run encerrada. Por isso cada ciclo de remediação inicia a **próxima run
da lineage**, ligada à anterior, em vez de mutar a run original: uma sessão automática é uma lineage de
runs — uma por ciclo — e cada definição permanece imutável e auditável.

Consequências verificadas:

- o draft é materializado uma única vez por sessão; ciclos posteriores reaproveitam a definição;
- o retry cobre o nó falho e o subgrafo que ele libera, então corrigir um nó libera os dependentes;
- uma falha de run anterior que não aparece no resultado da run seguinte **continua aberta**; ausência
  nunca é lida como sucesso;
- a delegação para um nó corretivo só é honrada quando o próprio corretivo verificou, então um corretivo
  que ainda não rodou não encerra a falha original;
- lineage, falhas abertas, nós verificados e delegações fazem parte do estado persistido, então o reload
  retoma a run correta sem duplicar run, attempt, nó corretivo ou ciclo.

Limites invioláveis:

- a remediação só pode endereçar o nó que falhou; redirecioná-la para outro nó é recusado, porque
  desfaria trabalho já verificado;
- o prompt completo de cada nó não entra na definição oficial: ele vive num store local por
  (run, nó, ciclo) que o resolver do adapter lê no momento do launch;
- um nó corretivo não pode reutilizar id existente e sempre roda depois do nó que corrige;
- o modo (`economic`, `standard`, `high-performance`) define orçamento e estratégia, nunca o mínimo de
  verificação; todo modo roda a verificação completa;
- os limites do modo são fixados pelo produto e sofrem clamp contra `ORCHESTRATOR_GLOBAL_LIMITS`; o
  modelo nunca amplia o próprio orçamento;
- ciclos de remediação, tentativas por nó e tempo total são finitos, então o loop não pode ser infinito;
- cancelamento é honrado inclusive quando surge durante a espera do resultado da run;
- o estado resumível é publicado no início e após cada ciclo, então recarregar retoma a mesma run em vez
  de criar uma segunda.

## Intervenção

O usuário pode:

- pausar o run ou uma etapa compatível;
- assumir um terminal;
- enviar orientação;
- devolver o controle ao workflow;
- substituir um runtime indisponível;
- repetir uma etapa segura;
- cancelar.

Assumir um terminal não marca a etapa como concluída. A retomada exige resultado estruturado e
revalidação do contrato.

## Quality gates

Gate de comando:

```yaml
type: quality_gate
command: pnpm test
timeout_ms: 600000
success:
  exit_code: 0
```

Gate composto:

- lint;
- typecheck;
- unit tests;
- integration tests;
- build;
- visual checks.

## Relatório final

Deve conter:

- objetivo;
- tarefas;
- agentes usados;
- branches/worktrees;
- arquivos alterados;
- decisões;
- checks;
- falhas/retries;
- riscos;
- passos manuais;
- sugestão de título e descrição de PR.
