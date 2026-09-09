# Roadmap por evidência

Este roadmap descreve o estado que o repositório comprova hoje. A referência detalhada de cada
capacidade é [23-current-capabilities.md](23-current-capabilities.md), e os objetivos e critérios
para beta estão em [24-beta-roadmap.md](24-beta-roadmap.md). O plano não pode ser substituído por
uma tela ou uma estimativa.

## Base local comprovada

- Electron local-first, SQLite versionado, migrations aditivas com backup pré-migration e IPC tipado;
- projetos e múltiplos workspaces persistidos, canvas, terminais, agentes, notas, conexões, autosave
  com revisão otimista, histórico de desfazer e projeções ao vivo;
- adapters funcionais para shell, Claude Code, Codex e fake-agent, com descoberta, capacidades,
  timeout e diagnósticos sanitizados;
- identidade local auditável, sessão rotacionável de CLI, endpoint limitado a loopback e Policy
  Engine de negação padrão para ações estruturais;
- CLI para agentes, mensagens, notas, artefatos, contexto, conexões, handoffs, histórico, runs e
  propostas, sempre usando os mesmos dados persistidos que o desktop;
- scheduler local, DAG, retries manuais, alternativas, checkpoints de contexto, quality gates,
  worktrees explícitos e relatório redigido de run;
- templates versionados, preview sanitizado e pacote `.compasso` inerte, sem escrita ou execução na
  importação;
- contexto selecionado de modo reproduzível, com regras de inclusão, hashes, versões e métricas de
  token/custo declaradamente estimadas quando o provider não as informa;
- empacotamento interno, checksums e manifests de release, sem publicação ou auto-update.

## Estado do produto nesta etapa

O produto é uma **alpha interna local**. O canvas, os terminais e a execução
manual/supervisionada têm fundação concreta, mas o vertical slice da visão ainda precisa ser
comprovado de ponta a ponta. Isso não prova uma beta pública nem autoriza chamar de autonomia
completa.

O produto-alvo possui um único canvas híbrido:

- **Montar manualmente:** a pessoa compõe o time com defaults úteis.
- **Começar/continuar com IA:** um agente-capitão do usuário propõe alterações no mesmo canvas.

Depois de aprovado, ambos devem usar o mesmo runtime e scheduler. O estado atual ainda não comprova
toda essa experiência; consulte `docs/25-product-realignment.md` para a ordem de correção.

## Trabalho restante antes da beta

- provar o vertical slice `montar → executar → acompanhar → validar → recuperar → reutilizar`;
- fazer composição manual e composição com IA convergirem para o mesmo canvas e runtime;
- ligar transições automáticas de run a resultados estruturados, sem microaprovação de cada etapa;
- comprovar intervenção, reload, retry seguro e reutilização de time;
- auditar requisito por requisito o plano A–H e registrar evidência atual para cada critério de
  saída;
- completar lacunas ainda não comprovadas do Policy Engine, lifecycle do runtime, recuperação,
  scheduler e seus clientes CLI/desktop;
- consolidar testes de migrations, recovery, segurança, acessibilidade e performance;
- executar e registrar jobs reais em Windows, macOS e Linux — matriz configurada não é validação;
- testar instalação, primeira abertura, persistência e desinstalação de cada artefato de plataforma;
- definir licença, política de privacidade, distribuição assinada, update seguro e limitações públicas.

## Limites deliberados

- Claude Code, Codex e OpenCode executam nós single-shot, validados contra os CLIs reais; somente
  Claude planeja, e não há orquestrador Codex ou OpenCode;
- não há terminal interativo de OpenCode nem fallback automático entre adapters durante uma run;
- uma conexão visual sozinha não inicia conversa ou execução;
- agentes não podem ampliar as próprias permissões;
- output bruto de terminal não é entrega;
- retries, merges, restaurações e envio de handoff não ocorrem silenciosamente;
- cloud, billing, telemetria e controle remoto continuam desligados por padrão;
- a compatibilidade comprovada é Windows local; macOS e Linux continuam pendentes de jobs reais.

Não há estimativas de semanas neste roadmap. Um item muda de estado somente quando implementação,
testes e evidência de runtime existem.
