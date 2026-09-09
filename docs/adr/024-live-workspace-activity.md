# ADR 024 — atividade local ao vivo baseada em eventos persistidos

Status: aceito

## Contexto

As projeções duráveis de notas, artefatos, conexões e criação de agentes já atualizavam o canvas.
Mensagens e handoffs também eram persistidos, mas uma ação feita pela CLI podia deixar a Inbox ou o
histórico de handoffs abertos no desktop desatualizados até uma ação manual.

## Decisão

`SqliteWorkspaceActivityStore` lê somente os eventos persistidos de mensagens e handoffs e mantém
watermarks por `rowid` durante a vida do processo principal. `WorkspaceActivityDispatcher` usa um
único observador debounced para os arquivos SQLite conhecidos (`db`, `-wal` e `-shm`) e uma varredura
de segurança de cinco segundos para sistemas de arquivos sem notificações confiáveis.

O IPC `workspace-activity:event` entrega exclusivamente IDs, tipo de assunto, ator estrutural,
timestamp e tipo de evento. Não entrega conteúdo de mensagem, saída de terminal, paths, comandos,
executáveis ou SQL. Cada inscrição no preload retorna uma função de cleanup; Inbox e histórico de
handoffs filtram pelo workspace ativo e removem o listener ao fechar ou recarregar.

## Consequências

- ações da CLI ficam visíveis ao vivo sem polling do renderer;
- uma recarga não depende de eventos transitórios: Inbox e histórico recarregam os dados SQLite, e
  as projeções do canvas já publicadas são reidratadas do snapshot persistido;
- os eventos antigos não são repetidos quando o desktop abre, pois o dispatcher inicia no watermark
  atual;
- não foi introduzido um segundo runtime ou canal de comando remoto.
