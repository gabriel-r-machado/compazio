# Analytics e privacidade

## Padrão

Sem telemetry até consentimento explícito.

## Eventos permitidos após opt-in

- app_started;
- onboarding_completed;
- project_added;
- adapter_detected com id/version, sem path;
- run_started;
- run_completed;
- run_failed com código categorizado;
- workflow_template_used;
- crash_report_created.

## Proibido

- código;
- prompt;
- output;
- path;
- branch privada;
- nome real de projeto;
- environment;
- token;
- conteúdo de nota;
- diff.

## Controles

- toggle;
- preview dos dados;
- export;
- delete;
- privacy policy;
- retention;
- redaction tests.
