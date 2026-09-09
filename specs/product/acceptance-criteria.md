# Critérios de aceite da beta pública

Esta lista é um gate de release, não uma declaração do estado atual. Cada item exige evidência
associada ao mesmo commit candidato.

## Onboarding e canvas

- instaladores testados em Windows, macOS e Linux;
- projeto local abre sem expor caminho ao renderer além dos contratos aprovados;
- shell funciona sem nenhuma IA instalada;
- Claude Code e Codex apresentam erro acionável quando ausentes ou não autenticados;
- terminal interativo aceita input, resize, cancelamento e encerra a árvore de processos;
- múltiplos workspaces e canvas restauram conteúdo e viewport;
- terminais, notas, materiais, artefatos e conexões sobrevivem ao reload;
- uma pessoa cria o primeiro terminal de agente escolhendo somente o runtime;

## Composição híbrida

- o mesmo canvas pode ser montado manualmente ou continuado com IA;
- alternar Manual ↔ Com IA preserva elementos, posições, contexto e histórico;
- o agente-capitão é um runtime instalado pelo usuário;
- o capitão recebe somente snapshot, capabilities e materiais autorizados;
- rascunho de workflow usa protocolo estruturado, validação e policy;
- propostas aparecem no canvas e podem ser editadas antes da execução;
- objetivo materialmente diferente não recebe silenciosamente o mesmo workflow fixo;
- falha do capitão preserva rascunho e não aciona fallback genérico.

## Execução

- um workflow com ao menos dois agentes, um artefato e um gate executa no fake-agent;
- o mesmo fluxo de referência executa em ao menos um adapter real;
- Manual e Com IA usam o mesmo scheduler e estados;
- terminais permanecem visíveis e interativos durante o run;
- usuário pode pausar, assumir um terminal, orientar e devolver o controle;
- dependentes só são liberados por resultado estruturado e contrato satisfeito;
- output bruto, frase final, silêncio ou encerramento do PTY não provam conclusão;
- transição automática autorizada em run formal não exige aprovar cada passagem;
- permissão nova, ação destrutiva, conflito, login e ambiguidade material pausam o fluxo;

## Contexto, perfis e reutilização

- missão, papel, contrato, fontes e política efetiva são persistidos;
- destino recebe contexto selecionado, decisões, restrições e artefatos, não o log completo;
- contexto efetivo possui versão/hash e motivo de inclusão;
- Econômico, Padrão e Alta Performance alteram política real dentro de limites globais;
- mudança de perfil afeta somente tarefas futuras;
- tokens e custos são identificados como reais ou estimados;
- time ou blueprint aprovado pode ser salvo, revisado e reutilizado em outro projeto;

## Falhas, Git e qualidade

- histórico de runs e entregas sobrevive ao reload;
- sessão perdida vira `interrupted` e oferece ação segura;
- retry cria tentativa auditável e não duplica entrega confirmada;
- worktrees concorrentes usam leases distintas quando o fluxo Git explícito é utilizado;
- gate real registra exit code e duração e bloqueia falha;
- relatório final distingue alegação do agente de evidência verificada;
- merge exige confirmação e cleanup preserva diretório dirty;

## Segurança, UX e release

- renderer permanece sem Node integration e sem API genérica de processo/filesystem;
- agentes não ampliam as próprias permissões;
- diagnóstico não contém segredo marcado;
- cloud, billing, remote control e telemetria permanecem desligados por padrão;
- acessibilidade essencial e budget de canvas possuem teste registrado;
- o caminho comum não exige configurar campos avançados antes de iniciar;
- lint, typecheck, testes, integração, build e E2E passam;
- cada job Windows/macOS/Linux foi realmente executado e seu resultado está registrado;
- limitações conhecidas, licença e política de segurança estão publicadas sem afirmações enganosas.
