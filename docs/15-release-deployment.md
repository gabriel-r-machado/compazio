# Release e deployment

## Estado atual

- builds de desenvolvimento existem;
- o desktop possui empacotamento local para NSIS (Windows), DMG/ZIP (macOS) e AppImage/DEB (Linux),
  além de manifest e checksums SHA-256 por canal `beta` ou `stable`;
- CI contém jobs para Windows, macOS e Linux;
- migrations pendentes criam um snapshot SQLite consistente e verificado antes de alterar um banco
  existente; recuperação só escreve em um banco novo e exige ação humana posterior;
- auto-update permanece desabilitado;
- instaladores públicos assinados, notarização e checksums ainda não têm evidência de release;
- a web e os serviços opcionais não são necessários para o core local.

## Gate para distribuir o desktop

- gerar artefato separado por plataforma;
- testar instalação, primeira abertura, terminal, persistência e desinstalação;
- assinar quando a infraestrutura e os certificados estiverem disponíveis;
- notarizar macOS quando aplicável;
- publicar checksums e changelog;
- verificar migrations e rollback;
- confirmar ausência de chaves no bundle;
- registrar o resultado real de cada job de plataforma.

## Artefatos de beta

`pnpm --filter @forgedeck/desktop package` produz o artefato da plataforma atual somente após build
e rebuild nativo. `release:manifest` gera `SHA256SUMS` e `release-manifest.json` a partir dos
entregáveis, sem caminhos absolutos. O workflow manual **Release artifacts** usa o mesmo fluxo em
runners nativos e só tenta assinatura quando a opção correspondente for escolhida e seus secrets de
CI existirem.

No Windows, `release:smoke:windows` abre o executável em `win-unpacked` com dados temporários. Isso
prova que o main process encontra as migrations em `resources/drizzle` antes da geração do instalador.

Esse fluxo não publica release, não habilita auto-update e não declara assinatura ou notarização.
Um instalador Windows unsigned foi gerado e verificado localmente para a beta interna; ele não é
uma distribuição pública nem evidência de macOS/Linux. Consulte ADR 047.

## Update

Auto-update só pode ser ativado depois que assinatura, origem do manifesto, verificação de
integridade e recuperação de falha estiverem implementadas e testadas. Até lá, a interface e a copy
devem dizer que ele está desabilitado.

## Banco local: backup e recovery

Antes de aplicar uma migration pendente em um banco já existente, o processo local cria e verifica
um snapshot SQLite em diretório derivado do banco. A migration é interrompida se o snapshot não
passar na verificação de integridade. O produto não faz rollback automático nem substitui o banco
ativo: a recuperação verificada só cria uma cópia separada, que deve ser revisada por uma pessoa
antes de qualquer troca manual. Consulte ADR 046.

## Cloud e billing

Cloud e billing são opcionais e ficam atrás de feature flags. Falhas nessas superfícies não podem
bloquear projetos, canvas, terminais, SQLite ou histórico locais.

## Versionamento

O produto usa SemVer. Schemas persistidos e públicos também possuem versão, e migrations devem ser
transacionais e testadas antes da release.
