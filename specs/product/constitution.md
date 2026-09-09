# Constituição do projeto

## Artigo I — Canvas como ambiente

Terminais reais, agentes, materiais, notas, artefatos e validações pertencem ao mesmo canvas
contínuo. O produto não separa o trabalho em um “modo manual” e outro “modo automático” incompatíveis.

## Artigo II — Local-first

O desktop deve ser útil sem login, cloud ou pagamento. Projeto, prompts completos, output de
terminal e segredos permanecem locais por padrão.

## Artigo III — Bring Your Own Agent

A inteligência vem dos runtimes instalados e autenticados pelo usuário. O produto não finge possuir
uma IA própria, não revende tokens no núcleo local e não acopla o domínio a um fornecedor.

## Artigo IV — Controle humano reversível

O usuário pode aprovar um workflow sem microgerenciar cada etapa segura, mas sempre pode pausar,
assumir um terminal, orientar, cancelar e retomar. Merge, deploy, exclusão, ampliação de permissões e
comandos destrutivos exigem consentimento explícito.

## Artigo V — Scheduler determinístico

Estado e transições pertencem ao engine. Agentes produzem propostas e artefatos; não são a autoridade do workflow.

## Artigo VI — Terminais reais, protocolo estruturado

O terminal é interativo e permanece visível no canvas, mas output bruto, silêncio, frase de conclusão
ou encerramento do PTY não são protocolo nem fonte de verdade. Automação usa adapters, eventos,
contratos e resultados estruturados.

## Artigo VII — Contexto econômico e explícito

Conexões definem acesso, dependência e entrega de forma explícita. Agentes recebem contexto e
artefatos relevantes ao contrato, não transcrições completas por padrão.

## Artigo VIII — Agent-agnostic

Nenhum adapter específico pode contaminar o domínio.

## Artigo IX — Git-native

Trabalho paralelo que modifica código usa isolamento por worktree ou estratégia equivalente aprovada.

## Artigo X — Observabilidade e recuperação

Toda execução relevante produz eventos estruturados e um resultado auditável. Falhas precisam ser
visíveis e oferecer uma recuperação segura; reload da interface não deve apagar o estado do trabalho.

## Artigo XI — Privacidade

Dados locais não sobem por padrão. Segredos nunca são enviados ao cloud do produto.

## Artigo XII — Qualidade

Alegação de sucesso não substitui exit code, testes, artefatos ou aprovação.

## Artigo XIII — Extensibilidade segura

Plugins e workflows declaram capacidades e permissões.

## Artigo XIV — Simplicidade progressiva

Robustez interna não justifica configuração excessiva na interface. Defaults, perfis, sugestões,
times salvos e blueprints devem tornar o caminho comum curto sem esconder decisões relevantes.

## Artigo XV — Escopo disciplinado

O produto não será uma IDE completa no MVP.
