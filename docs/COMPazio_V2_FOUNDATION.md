# Compazio V2 — fundação da Fase 1

## Entrega

A Fase 1 introduz uma base V2 separada, local-first e Windows-first, com workspaces, canvas mínimo,
notas, terminais reais, conexões visuais e limpeza de processos. O produto legado continua no seu
entrypoint atual.

## Estrutura

```text
apps/desktop/
├── electron.vite.config.ts       # legado
├── electron.vite.v2.config.ts    # V2 isolada
└── src/v2/
    ├── main/                     # composição, IPC e lifecycle
    ├── preload/                  # API mínima validada
    └── renderer/                 # sidebar + canvas + xterm
packages/
├── compazio-v2-domain/
├── compazio-v2-persistence/
└── compazio-v2-runtime/
```

## Persistência e recuperação

Os arquivos ficam em `<userData>/compazio/v2/`:

```text
index.json
index.json.bak
workspaces/<workspace-id>.json
workspaces/<workspace-id>.json.bak
```

Cada escrita é validada, gravada em arquivo temporário, sincronizada e renomeada; a última versão
válida é copiada para `.bak` antes da substituição. Arquivo primário inválido tenta o backup sem
sobrescrever o original. O schema começa em `1` e contém uma migração explícita de V0. A remoção de
workspace não toca no diretório de código selecionado.

## Interface e IPC

O preload expõe operações específicas para workspace, nó, aresta e terminal. Não há `ipcRenderer`,
filesystem, shell genérico nem handle de processo no renderer. Todos os payloads são Zod-parseados
nos dois lados da ponte. O BrowserWindow usa `contextIsolation: true`, `nodeIntegration: false`,
sandbox e CSP restritiva.

O canvas oferece pan, zoom persistido, enquadramento, seleção, arraste, redimensionamento,
terminais, notas e conexões visuais. Um terminal abre o shell padrão com zero configuração; o botão
**Configurar** permite usar um executável e argumentos explícitos dentro do diretório do workspace.

## Como executar

```powershell
pnpm dev:desktop:v2
pnpm --filter @forgedeck/desktop build:v2
```

## Como testar

```powershell
pnpm test
pnpm test:integration
pnpm --filter @forgedeck/desktop build:v2
pnpm test:v2-electron-smoke
```

O smoke V2 abre Electron duas vezes de verdade, atravessa renderer/preload/IPC, cria workspace e
terminal, executa um processo controlado por pipe, recebe saída e move o nó na primeira abertura.
Na segunda, restaura o workspace, exclui o terminal e confirma que ele não retorna.

## Limitações conhecidas

- `waiting-input` não é detectado por heurística nesta fase.
- Processos ativos não são retomados depois de fechar ou recarregar; voltam parados por segurança.
- A interface usa prompts mínimos para configuração avançada; não há inspector completo.
- As conexões são exclusivamente visuais e não concedem permissão, contexto ou comunicação.

## Próxima etapa

A Fase 2 deve adicionar presets/detecção de Claude Code, Codex e OpenCode, responsabilidades e
injeção de instruções por workspace. Bridge, CLI, recrutamento e comunicação entre agentes pertencem
à Fase 3, não a esta fundação.
