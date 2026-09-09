# Local-first, privacidade e segurança

## Threat model

A aplicação executa processos com acesso a código local. Isso exige assumir que:

- prompts podem conter instruções maliciosas;
- repositórios podem conter scripts perigosos;
- output de terminal pode tentar explorar renderer;
- plugins podem ser não confiáveis;
- deep links podem ser manipulados;
- webhooks podem ser falsificados;
- logs podem vazar segredos.

## Regras obrigatórias

### Electron

- `contextIsolation: true`
- `nodeIntegration: false`
- sandbox quando compatível;
- CSP estrita;
- preload mínimo;
- navegação externa em browser do sistema;
- bloquear `window.open` não permitido;
- validar todos os payloads IPC com Zod;
- nunca aceitar nome de canal arbitrário.

### Processos

- usar arrays de args;
- working directory validado;
- environment allowlist;
- timeout;
- process tree kill;
- limite de output;
- confirmação para comandos destrutivos;
- não executar arquivo de workflow baixado sem preview/aprovação.

### Segredos

- preferir autenticação dos CLIs existentes;
- tokens do app no OS keychain/safeStorage;
- chaves de serviço somente no servidor;
- nunca Supabase service role no desktop/renderer;
- redaction centralizada.

### Cloud

Sincronizar somente por opt-in:

- nome público do projeto definido pelo usuário;
- status de run;
- duração;
- tipo de adapter;
- resumo sanitizado;
- métricas agregadas.

Não sincronizar por padrão:

- paths;
- código;
- diffs;
- prompt completo;
- terminal output;
- env;
- tokens;
- notas privadas.

### Plugins

Fase inicial:

- apenas plugins instalados manualmente;
- manifest;
- hash;
- permissões;
- origem;
- versão;
- desabilitar automaticamente após crash repetido.

Futuro:

- assinatura;
- registry;
- review;
- sandbox por processo.

## Telemetria

Opt-in. Evento permitido deve ser documentado em `docs/16-analytics-privacy.md`.

## Atualizações

- releases assinadas;
- checksums publicados;
- canal stable/beta;
- rollback;
- update automático somente depois de pipeline seguro.
