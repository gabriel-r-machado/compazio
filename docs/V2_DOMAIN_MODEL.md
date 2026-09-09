# Compazio V2 — modelo de domínio

O domínio vive em `@forgedeck/compazio-v2-domain` e não importa React, Electron, xterm ou código de
processos. Todos os dados são validados com Zod e serializáveis.

```text
Workspace (schemaVersion: 1)
├── CanvasNode[]
│   ├── TerminalNode
│   │   ├── TerminalLaunchConfig
│   │   └── sessionId?  (somente projeção em memória)
│   └── NoteNode
├── CanvasEdge[]  (visual)
└── WorkspaceSettings (viewport)
```

Os nós possuem ID estável, `workspaceId`, posição, tamanho e timestamps. Os tipos discriminados
`terminal` e `note` evitam atributos implícitos. Uma conexão visual sempre aponta para dois nós do
mesmo workspace; o domínio remove conexões órfãs no carregamento e ao excluir um nó.

`TerminalLaunchConfig` contém executável opcional, argumentos em array, ambiente não sigiloso e modo
`auto | pty | pipe`. Segredos não podem ser serializados: chaves de ambiente com `token`, `secret`,
`password`, `api_key` ou `credential` são rejeitadas. Um caminho de executável pode conter espaços;
ele nunca é concatenado a uma string de shell.

Operações disponíveis:

- criar/renomear workspace e atualizar viewport;
- adicionar, mover, redimensionar, atualizar e remover nó;
- criar/remover aresta visual e eliminar órfãs;
- validar consistência, serializar e carregar/migrar.

O `sessionId` é uma associação efêmera que só a projeção enviada ao renderer pode conter. A função
`toPersistentWorkspace` a remove antes de qualquer escrita, portanto nenhum handle, PID ou processo
é persistido.
