# Segurança de Portais

## Isolamento do conteúdo remoto

Portais são criados com `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`,
`webSecurity: true`, `webviewTag: false`, `nodeIntegrationInSubFrames: false` e recursos
experimentais desativados. O processo principal é o único dono do `WebContents`: o renderer do
Compazio nunca recebe `Session`, `WebContents` nem capacidade genérica de automação — só pode pedir
operações validadas por IPC tipado com Zod e allowlist.

## Política de URL

`https:` é permitido. `http:` fica restrito a `localhost`, `127.0.0.1`, `::1` e redes RFC1918, para
desenvolvimento local e para a fixture de teste. `file:`, `data:`, `javascript:` e protocolos
desconhecidos são recusados com `PORTAL_PROTOCOL_BLOCKED`, tanto na navegação pedida quanto em
`will-navigate` disparado pela própria página.

## Autorização por conexão

Controlar um Portal exige uma aresta direcionada terminal → Portal com a capacidade
`portal-control`. **Ser Orquestrador não concede nada**: sem a conexão, um orquestrador recebe o
mesmo `PORTAL_NOT_CONNECTED` que um recruta. Remover a conexão, excluir o terminal ou excluir o
Portal revoga o acesso imediatamente e cancela as operações já em voo daquele par.

`compazio portal list` mostra os Portais do workspace com `controllable` por terminal — listar não é
controlar, e o agente precisa saber o que pode alcançar antes de tentar.

## Popups, permissões e mídia

`setWindowOpenHandler` nega qualquer janela nova e registra `portal.popup.blocked`. Permissões
(câmera, microfone, geolocalização, notificações, área de transferência) são negadas por handler de
requisição e de verificação; captura de tela do sistema é recusada sem seletor.

## Downloads

O bloqueio simples virou fluxo com decisão humana. A página propõe **um nome, nunca um caminho**:
separadores, travessia, caracteres de controle e nomes de dispositivo do Windows são removidos, o
destino precisa ficar dentro da pasta autorizada e um arquivo existente é renomeado em vez de
sobrescrito sem confirmação. Sem resposta ao diálogo do Compazio, nada é gravado; nada é aberto
automaticamente; cada decisão gera evento (`portal.download.requested`, `.accepted`, `.cancelled`,
`.completed`, `.failed`).

## O que nunca sai do Portal

DOM, árvore acessível e console são respostas de dados, não de objetos: sem cookies, sem
`localStorage`, sem `sessionStorage`, sem tokens, sem headers, sem corpo de rede e sem APIs
Electron. Valores de campo sensível (senha, cartão, segredo, token, CVV) são omitidos, e o console é
redigido antes de ser armazenado.

## Sessões

Cada Portal isolado usa a própria partição persistente; `workspace-shared` compartilha a partição
apenas entre Portais do mesmo workspace que declaram a mesma `sessionKey`. A chave é gerada pelo
domínio — o renderer nunca escolhe o nome de uma partição do Electron.

## MCP local

O gateway MCP escuta somente em loopback (`127.0.0.1`) e valida Host, Origin e Bearer token em cada
requisicao. O token e aleatorio, expira, e associado a um terminal e workspace e so o hash permanece
na memoria do processo principal. Ele nao e persistido, enviado ao renderer ou registrado em logs.

Uma sessao MCP de transporte nao substitui a sessao Compazio. Mesmo depois de `initialize`, cada
chamada volta a validar token, expiracao, revogacao, terminal, workspace, capability e a aresta
terminal -> Portal com `portal-control`. O Orquestrador sem essa aresta recebe
`PORTAL_NOT_CONNECTED`.

## Configurações MCP de clientes reais

Claude Code e Codex recebem apenas configuração temporária por processo e um token no ambiente do
processo filho. O token não é persistido, mostrado no renderer, colocado no prompt nem registrado
nos logs. O harness de OpenCode 1.17.7 segue a mesma regra: cria `opencode.jsonc` sob
`XDG_CONFIG_HOME` temporário com `Bearer ${COMPAZIO_MCP_TOKEN}`, remove o diretório no cleanup e
nunca modifica a configuração global do usuário. A indisponibilidade do provider OpenCode ocorreu
antes de qualquer requisição ao loopback e não resultou em relaxamento de capability, shell ou
permissão.
