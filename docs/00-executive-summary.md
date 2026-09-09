# Resumo executivo

## O problema

Pessoas que trabalham com mais de um agente de código acabam espalhando a operação entre terminais,
janelas, documentos e conversas. Elas repetem contexto, perdem decisões, não sabem com clareza o que
cada agente deve entregar e precisam intermediar manualmente cada passagem de trabalho.

Abrir vários terminais resolve a visualização, mas não resolve a coordenação. Um chat autônomo resolve
parte da automação, mas esconde a operação e reduz o controle. O produto existe para unir esses dois
lados.

## O produto

Compasso é um workspace visual local-first no qual terminais reais, agentes já instalados pelo
usuário, materiais, notas, artefatos, tarefas e validações vivem no mesmo canvas.

O usuário pode montar seu time diretamente ou entregar temporariamente a composição do canvas a uma
IA que já usa. Depois de aprovado, o workflow executa automaticamente pelo runtime determinístico do
Compasso. A qualquer momento, o usuário pode pausar, entrar em um terminal, corrigir uma direção,
reorganizar o canvas e devolver o controle ao fluxo.

> O terminal vive dentro do canvas, e o canvas dá contexto, coordenação e memória ao terminal.

O Compasso não possui modelo próprio, não revende tokens e não substitui Claude Code, Codex,
OpenCode ou outros runtimes. Ele usa instalações e autenticações existentes, aplica políticas e
transforma o trabalho dos agentes em uma operação visível, reutilizável e recuperável.

## Promessa central

> Monte o time no canvas, execute o trabalho em fluxo e assuma o controle quando quiser.

## Como funciona

1. O usuário abre um projeto e adiciona materiais.
2. Monta o canvas manualmente ou pede a um agente-capitão para propor o time.
3. Revisa papéis, conexões, permissões, orçamento e critérios de conclusão.
4. O scheduler executa tarefas e dependências de forma previsível.
5. Agentes trocam entregas estruturadas e artefatos relevantes, não transcrições completas.
6. Terminais permanecem visíveis e interativos durante a execução.
7. Gates reais verificam código, build, testes e outros resultados aplicáveis.
8. O usuário recebe histórico, evidências, custos estimados, falhas e opções de recuperação.

## Diferenciais

- canvas contínuo e híbrido, não dois produtos chamados “Manual” e “Automático”;
- terminais PTY reais como elementos de primeira classe;
- composição manual simples ou composição assistida pela IA do próprio usuário;
- execução automática baseada em estado, eventos e contratos explícitos;
- comunicação econômica por contexto selecionado, artefatos e handoffs estruturados;
- perfis Econômico, Padrão e Alta Performance que alteram a estratégia de execução;
- reutilização por perfis de agentes, times salvos e blueprints;
- controle humano sobre permissões, ações destrutivas, merge e deploy;
- persistência local, recuperação e independência de fornecedor.

## Recorte do primeiro produto confiável

A plataforma é geral, mas o primeiro recorte precisa provar um ciclo completo:

`objetivo + materiais → time → execução → validação → entrega recuperável`

Esse ciclo deve funcionar primeiro para construção de software em projeto local, usando shell,
Claude Code e Codex. Landing pages premium, SaaS, aplicativos, correções e auditorias são casos de uso
desse mesmo sistema; não são arquiteturas separadas.

## O que não é

- uma IDE completa;
- um modelo ou agente próprio;
- apenas um painel com vários terminais;
- um chat em grupo entre agentes;
- um gerador fixo de workflows genéricos;
- uma automação baseada em simular teclas e adivinhar o estado pelo texto do terminal;
- uma plataforma cloud obrigatória.

## Regra de produto

Uma funcionalidade pertence ao núcleo quando melhora pelo menos um destes pontos:

1. montar o time;
2. fornecer contexto;
3. executar o fluxo;
4. acompanhar ou intervir;
5. validar a entrega;
6. recuperar ou reutilizar o trabalho.

Se não melhorar nenhum deles, não deve disputar prioridade no núcleo local.

O estado real do produto e as limitações comprovadas permanecem documentados em
`docs/23-current-capabilities.md`.
