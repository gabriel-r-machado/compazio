# ADR 033 — Workflows executam somente no alvo de projeto aprovado

## Contexto

O scheduler agora pode acionar um executor de shell real para templates internos
confiáveis. A CLI e o renderer, porém, não podem enviar paths, executáveis,
args, diretórios de trabalho ou comandos ao processo desktop.

## Decisão

- Ao solicitar uma run pela CLI, apenas o `workspaceId` é persistido junto ao
  comando tipado. O desktop resolve esse ID para o projeto local já aprovado.
- Antes de iniciar a run, o dispatcher associa de forma imutável o `runId` aos
  IDs opacos de workspace e projeto em `workflow_run_targets`.
- O root canônico do projeto fica em um registro somente em memória do runtime.
  Ele não é gravado na run, no comando, nos eventos, no IPC ou na saída da CLI.
- O executor de shell recebe somente um comando de template confiável e usa o
  `ProcessSupervisor` para validar o root, o cwd e o executável. A associação
  em memória é liberada assim que a run encerra; retries resolvem novamente o
  alvo persistido.
- A associação não tem foreign key para a run porque a persistência da run é
  assíncrona ao start do scheduler. Ela mantém foreign keys restritivas para
  workspace e projeto, e o dispatcher só a cria após resolver ambos.

## Consequências

Uma run pode ser recuperada ou repetida com o mesmo alvo lógico sem tornar
caminhos locais parte de um contrato público. Um erro logo após o start pode
deixar um vínculo de alvo sem run correspondente; ele é inofensivo, não concede
acesso e será tratado por limpeza de retenção do runtime quando essa política
for introduzida.
