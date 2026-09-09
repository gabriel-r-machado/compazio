# Registro de riscos

| Risco                                   |    Impacto | Mitigação                                                |
| --------------------------------------- | ---------: | -------------------------------------------------------- |
| Escopo virar IDE completa               |       Alto | Não objetivos e roadmap por fases                        |
| Adapters quebrarem após update dos CLIs |       Alto | Contrato, capability matrix, testes e version pin hints  |
| Electron consumir memória               | Médio/alto | Um renderer, buffers limitados, virtualização, profiling |
| Agentes alterarem mesma branch          |       Alto | Worktree e lease explícitas antes do trabalho paralelo   |
| Parsing de TUI ser frágil               |       Alto | Preferir modos estruturados; gates independentes         |
| Vazamento de segredo                    |    Crítico | Redaction, keychain, env allowlist, testes               |
| Workflow executar comando malicioso     |    Crítico | Preview, permissões, confirmação e trust model           |
| Cloud destruir confiança local-first    |       Alto | Opt-in, sync mínimo, documentação                        |
| Billing antes de product-market fit     |      Médio | Feature flag e fase posterior                            |
| Projeto parecer cópia                   |       Alto | Marca, UI e tese próprias                                |
| Comunidade sem contribuição             |      Médio | SDK simples, good first issues, templates                |
| Windows PTY inconsistente               |       Alto | Testes reais locais e execução registrada no CI          |
| Matriz confundida com suporte validado  |       Alto | Registrar job e instalador testado por plataforma        |
| Reenvio duplicado após crash            |       Alto | Estado incerto e retry somente por ação humana           |
| Merge automatizado gerar perda          |    Crítico | Confirmação humana, backups e dry-run                    |
