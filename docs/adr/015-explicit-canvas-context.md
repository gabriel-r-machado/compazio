# ADR 015 — contexto explícito por conexão de canvas

Status: aceito

## Contexto

O Modo Livre permite notas, agentes e conexões no canvas, mas uma conexão visual não pode significar
que todo o conteúdo do workspace é disponibilizado ou enviado automaticamente a um agente. Isso
criaria um fluxo implícito, difícil de auditar e incompatível com a revisão humana dos handoffs.

## Decisão

`compasso connect <agent> <note-or-artifact>` cria uma aresta direta `nota/artefato → agente` e enfileira sua projeção
para o canvas aberto. A operação é idempotente e recusa ciclos e duplicidades. `compasso context
<agent>` resolve uma visão local e somente de leitura composta pela missão do workspace e pelas
notas e artefatos que possuem essa conexão direta. Cada fonte preserva o ID do nó, o ID da conexão
e o contrato versionado que autorizou sua presença. Um artefato é aceito somente quando os metadados
do nó correspondem ao registro imutável publicado; o resultado inclui ID, caminho gerenciado, hash,
tamanho e media type, nunca o conteúdo. O resolver não percorre caminhos indiretos, não usa output
de terminal, não inicia processos e não escreve no PTY.

Uma pessoa local pode inspecionar a visão de qualquer agente. Quando a chamada declara `--from`, o
nó precisa ser um agente capaz, possuir `read_context` e ser exatamente o agente cujo contexto está
sendo solicitado. Para criar uma conexão por `--from`, ele também precisa possuir `connect_context`
e ser o próprio destino. Essa identidade é estrutural; não é autenticação criptográfica.

## Consequências

- desconectar uma nota ou artefato o remove imediatamente do resultado de contexto do agente;
- o comando cria uma superfície auditável para o agente obter contexto sem transformar conexões em
  automação autônoma;
- os limites de conteúdo continuam os da nota persistida; nenhum texto adicional é copiado para o
  banco;
- bytes de artefatos não entram no contexto, no IPC ou na entrada de um adaptador;
- a aprovação e a entrega de handoffs continuam separadas e humanas.
