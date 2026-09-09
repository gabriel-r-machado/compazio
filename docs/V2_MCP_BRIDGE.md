# Extensão Compazio (Onda 5A)

O mesmo gateway local também expõe a superfície mínima de equipe. A capability de sessão define
descoberta e a operação é revalidada pelo `TeamCoordinator`; `isCompazio` sozinho não é uma
autorização genérica para Portais, arquivos ou outro workspace.

Para um Compazio, a sessão é criada com `team-read`, `team-recruit`, `team-manage`, `task-create`,
`task-assign` e `message-send`. A allowlist de cliente usada pelo fluxo Claude real reduz a
superfície a `team_recruit`, `team_status`, `team_list`, `team_dismiss`, `task_status`,
`task_result` e `message_list`. O token, endpoint e configuração temporária continuam internos ao
processo filho.

O update de `isCompazio` revoga sessões MCP do terminal antes de reiniciá-lo. A sessão posterior é
nova e derivada novamente do canvas; ao desativar Compazio, as tools administrativas deixam de ser
anunciadas. O probe de lifecycle usa Streamable HTTP real para verificar terminal comum, promoção,
recrutamento fake, despromoção e cleanup.

## Compazio bidirecional

As tools de equipe são independentes do provider: uma sessão Codex com `isCompazio` recebe
`team-read`, `team-recruit`, `team-manage`, `task-create`, `task-assign` e `message-send`, na mesma
superfície limitada já usada por Claude. O gateway não aceita terminal, workspace, token, comando
ou ambiente no argumento da tool; essas identidades vêm da sessão autenticada.

O harness real usa configuração MCP temporária por processo e pode selecionar
`--compazio codex --recruit claude-code`. A validação confirmada cobre descoberta, recrutamento,
papel, tarefa, `task_result`, leitura pelo Compazio, `team_dismiss` e limpeza. Não existe fallback
por Bash, PATH ou configuração global de Codex/Claude.

# Bridge MCP local

O Compazio expoe recursos de agente pelo gateway MCP local, sem depender do shell ou da CLI para a
integracao estruturada. A CLI `compazio portal` continua sendo interface humana e de diagnostico;
CLI e MCP delegam aos mesmos servicos de autorizacao e runtime.

## Transporte

O processo principal inicia uma vez um endpoint Streamable HTTP em `127.0.0.1` em porta aleatoria.
Ele usa `@modelcontextprotocol/sdk@1.30.0`, `McpServer` e
`StreamableHTTPServerTransport`; o probe interno negociou a versao `2025-11-25`.

Nos clientes reais, Claude Code 2.1.220 enviou `2025-11-25` e Codex CLI 0.144.6 enviou
`2025-06-18`. Essa versao vem somente do request `initialize` e e mantida como telemetria
sanitizada de teste; nenhum payload, header Authorization ou token e registrado.

O transporte MCP possui seu proprio session ID. Ele e apenas continuidade de protocolo e nao
autoriza o agente. A sessao Compazio carrega o escopo de terminal, workspace, capability, expiracao
e hash do token. Cada requisicao autentica o Bearer novamente e confirma que o transport permanece
ligado a mesma sessao Compazio.

## Ferramentas

O gateway publica `portal_list`, `portal_get`, `portal_dom`, `portal_accessibility`,
`portal_console`, `portal_viewport`, navegação, interação, `portal_screenshot` e `portal_close`.
Cada schema é estrito e não recebe `workspaceId`, `terminalId`, token ou capability do modelo:
esses valores vêm da sessão autenticada. As respostas são limitadas, serializáveis e têm
`correlationId`. Nenhuma ferramenta de shell, filesystem, Git, Electron, WebContents, Session ou
`evaluate` é publicada.

Capabilities são derivadas da conexão terminal → Portal: `portal-read` para leitura,
`portal-control` para navegação/interação, `portal-screenshot` para imagens e `portal-close` para
destruição. `portal-control` também concede leitura, mas não screenshot ou fechamento.

## Bootstrap invisível

Ao iniciar um terminal Claude Code ou Codex, a Bridge cria a sessão MCP, escreve a configuração
temporária do adapter e injeta somente os argumentos e a variável de ambiente do processo filho.
Não há tela, URL, token ou configuração manual para a pessoa usuária. A sessão começa como
`connecting`/`limited` e passa a `connected` após a primeira requisição MCP aceita; o diagnóstico
mantém esses detalhes fora do fluxo principal. Parar o terminal remove a configuração e revoga o
token. Reiniciar o terminal cria uma nova sessão.

## Revogacao e limpeza

Remover `portal-control`, encerrar ou excluir terminal, fechar workspace, revogar sessao ou
encerrar o aplicativo fecha os transports relacionados. Tokens nao sao persistidos, nao chegam ao
renderer e nunca aparecem nos logs. O gateway oferece telemetria sanitizada para testes reais: tool
calls e requests HTTP sem Authorization ou valor de token.

## Validação final com clientes reais

O fluxo completo de Portal foi repetido com Claude Code depois da correção de bounds: o cliente
negociou `2025-11-25`, chamou somente tools `mcp__compazio__portal_*` e recebeu
`PORTAL_NOT_CONNECTED` numa sessão sem conexão. Codex concluiu o mesmo fluxo com `2025-06-18`.

OpenCode não participa do bootstrap automático desta onda. O harness suporta sua configuração MCP
remota somente em `XDG_CONFIG_HOME` temporário, sem alterar o perfil global; a versão 1.17.7 ficou
bloqueada pelo provider antes de abrir uma sessão MCP.
