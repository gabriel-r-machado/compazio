# Política de permissões de agentes

Cada workspace persiste uma `WorkspacePermissionPolicy` com acesso a arquivos, ações destrutivas, caminhos externos e rede. O default é conservador: perguntar para arquivos/ações destrutivas, sempre perguntar para caminhos externos e manter rede no padrão do agente.

O Compazio garante que o diretório de trabalho do terminal pertence ao workspace e informa a política ao processo por ambiente. Ele não afirma controlar permissões internas de CLIs externas: Claude Code, Codex, OpenCode e comandos customizados podem exigir suas próprias confirmações/configurações. Esta limitação é exibida quando a política não é o default.

Não há persistência de segredos em políticas, presets ou launch config. Variáveis com nomes de token, segredo, senha, credencial ou chave de API são rejeitadas antes da gravação.
