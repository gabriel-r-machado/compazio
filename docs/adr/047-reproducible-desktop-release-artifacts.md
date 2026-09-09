# ADR 047 — artefatos reproduzíveis de distribuição desktop

## Contexto

O desktop local precisava gerar instaladores e checksums sem ativar atualização remota, publicar
artefatos automaticamente ou alegar assinatura inexistente. Os módulos nativos precisam ser
recompilados para o ABI do Electron por um fluxo já controlado pelo projeto.

## Decisão

- O desktop usa `electron-builder` somente depois do build e do rebuild nativo controlado por
  `native:electron`; o empacotador não faz um segundo rebuild próprio.
- As migrations SQLite versionadas são copiadas para `resources/drizzle`, que é o único caminho de
  migrations usado pelo main process no app empacotado. O workflow executa o smoke real do diretório
  `win-unpacked` depois de montar o pacote Windows.
- O smoke empacotado usa um repositório de fixture real para a revisão de handoff. O bundle `app.asar`
  nunca é tratado como diretório de projeto; a fixture só existe no modo de smoke local e não altera
  a resolução de projetos usada pelo produto.
- O pacote gera NSIS no Windows, DMG/ZIP no macOS e AppImage/DEB no Linux. O workflow manual de
  release gera cada plataforma em runner nativo e armazena os artefatos como evidência de CI.
- O manifest `1.0` e `SHA256SUMS` incluem somente entregáveis e blockmaps, ordenados de forma
  determinística e sem caminhos absolutos. Eles são metadados de distribuição, não manifestos de
  auto-update.
- Canais `beta` e `stable` são campos explícitos do manifest. O app não lê esse manifest e
  auto-update continua desligado.
- A assinatura é opt-in no workflow. Quando solicitada, usa apenas secrets de CI e falha se eles não
  estiverem disponíveis; um binário não assinado jamais é rotulado como assinado.

## Consequências

É possível produzir e auditar artefatos de beta internos em Windows sem expor filesystem, comandos
ou credenciais ao produto. Uma release pública ainda exige certificados, eventual notarização do
macOS, execução real dos três runners e publicação consciente das notas de release e checksums.
