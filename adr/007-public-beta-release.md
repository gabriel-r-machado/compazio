# 007 — Beta pública: distribuição verificável sem auto-update

## Contexto

A beta pública precisa instalar em Windows, macOS e Linux sem remover a
propriedade local-first do desktop. O repositório ainda não possui uma
identidade de publicação, certificados de assinatura, credenciais Apple ou um
canal de atualizações. Não é seguro declarar uma cadeia de atualização antes
de conseguir assinar, hospedar e verificar cada artefato.

## Decisão

- Empacotar o desktop com `electron-builder`, depois do build feito pelo
  `electron-vite`.
- Produzir NSIS no Windows, DMG no macOS e AppImage mais DEB no Linux. Cada
  artefato recebe nome com plataforma e arquitetura e um checksum SHA-256.
- Usar `io.forgedeck.desktop` como identidade temporária de empacotamento. Ela
  deve ser confirmada antes da primeira publicação assinada, pois mudanças
  posteriores alteram a identidade instalada.
- Permitir assinatura e notarização apenas quando os segredos exigidos pela
  plataforma estiverem configurados. Sem eles, a pipeline gera artefatos não
  assinados marcados como tal; a checklist de release bloqueia a publicação de
  uma beta que prometa instalação sem avisar esse limite.
- Não incluir `electron-updater`, não configurar `publish` no empacotador e
  não chamar `autoUpdater`. O produto apresenta a política como “atualizações
  automáticas desabilitadas nesta beta”.
- Um workflow manual constrói e anexa artefatos de teste; ele não publica
  releases e não recebe permissões de escrita por padrão.

## Consequências

- Usuários atualizam manualmente, verificando o checksum publicado.
- Windows e macOS podem exibir avisos do sistema enquanto não houver
  assinatura/notarização. Linux depende da disponibilidade das bibliotecas da
  distribuição e do formato escolhido.
- Antes de publicar, a equipe precisa provisionar certificados, validar a
  identidade de aplicativo, habilitar divulgação privada de vulnerabilidades
  e executar a checklist em máquinas reais das três plataformas.

## Alternativas rejeitadas

- Atualização automática sem assinatura: o Electron exige assinatura para o
  fluxo seguro no macOS e não há atualizador nativo para Linux.
- Publicar por CI nesta fase: o repositório não possui remoto, commit de base
  nem credenciais autorizadas para criar releases.
