# ADR 017 — descoberta do runtime local por projeto

Status: aceito

## Contexto

O desktop mantém o SQLite no perfil local do usuário, enquanto a CLI antes exigia que a pessoa
informasse o caminho por `COMPASSO_DB_PATH`. Isso impedia o uso normal do Compasso a partir de um
diretório de projeto e incentivava caminhos copiados manualmente.

## Decisão

Quando um projeto local é aberto ou clonado pelo desktop, o processo principal registra um manifesto
local em `.forgedeck/compasso-runtime.json`. Ele contém o root canônico do projeto, o banco local
canônico e a versão do formato. O manifesto é consumido exclusivamente pela CLI local; nunca cruza
IPC nem é enviado ao renderer.

A CLI verifica somente esse nome de arquivo no diretório corrente e em seus ancestrais, sem enumerar
diretórios. Ela valida que o manifesto pertence ao mesmo projeto e que o banco é um arquivo local
existente. `--database` e as variáveis antigas permanecem como fallbacks explícitos de compatibilidade.
Se nada for encontrado, a mensagem orienta abrir o projeto no ForgeDeck ou informar `--database`, sem
imprimir paths.

## Consequências

- `compasso` passa a funcionar normalmente dentro de projetos já abertos pelo desktop;
- um manifesto corrompido falha fechado, sem abrir banco arbitrário;
- projetos já registrados recebem o manifesto no próximo início do desktop;
- `--from` não ganha função de autenticação com esta decisão.
