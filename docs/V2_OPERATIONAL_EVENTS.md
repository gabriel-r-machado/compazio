# Eventos e histórico operacional

O Compazio mantém um event store leve para auditoria, timeline e diagnóstico.
O estado principal continua persistido normalmente; não há event sourcing
completo.

Cada `RunEvent` contém ID, tipo, workspace, run opcional, ator, alvo, horário,
correlation ID, metadata segura e versão do schema. São registrados eventos de
execução, agente, responsabilidade, tarefa, conexão, nota, atenção, política,
layout, recuperação e falha de notificação.

## Privacidade e retenção

Metadata passa por sanitização por nome de campo. Tokens, segredos, senhas,
credenciais, prompts, stdout, conteúdo e caminhos são descartados. Strings
permitidas são limitadas. A saída integral do terminal não é duplicada.

O documento operacional retém por padrão os 2.000 eventos e as 1.000 atividades
mais recentes. Previews de conexão têm no máximo 280 caracteres. O conteúdo
integral permanece na fonte original quando permitido.

## Interface

A timeline oferece filtros para tudo, agentes, tarefas, erros, notas e
conexões. O inspector de uma conexão mostra direção, capacidades, último estado,
tentativa, duração, preview seguro e correlation ID. Falhas aplicáveis oferecem
retry sem alterar o evento anterior.

Eventos técnicos brutos aparecem apenas no diagnóstico exportável. A timeline
usa descrições operacionais legíveis.
