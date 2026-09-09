# Nome e marca

## Marca do produto

`COMPAZIO` é a marca pública única do produto e da coordenação da equipe do workspace. Nenhuma
interface, prompt ou documentação pública deve apresentar marcas ou papéis legados como identidade
principal do produto.

`ForgeDeck` permanece apenas como codinome técnico em nomes de pacotes, IPC e chaves locais para
evitar uma migração incompatível sem benefício ao usuário. Identificadores internos legados
permanecem no código apenas por compatibilidade. O valor exibido do papel vem de
`ORCHESTRATOR_LABEL`, em `packages/compazio-v2-domain/src/brand.ts`.

No V2 o papel que coordena a equipe é exibido como `COMPAZIO`. O vocabulário técnico
`compazio` (`isCompazio`, `compazioTerminalId`, `compazio.enabled`) permanece interno para não
quebrar documentos existentes. Documentos gravados antes da troca ainda podem carregar campos
legados; as migrações de schema os traduzem na leitura.

### Conceito

**Precisão. Fluxo. Controle.**

O símbolo combina os sinais de um terminal com uma forma de controle compacta. A assinatura usa
`COMPAZIO` em caixa alta.

### Sistema visual

- tema padrão preto, com superfícies em grafite e linhas neutras;
- Manrope para títulos e marca no desktop V2 (Geist permanece no site e na V1);
- Inter para interface e texto;
- JetBrains Mono para código e terminais;
- paleta: `#0A0A0A`, `#1A1A1A`, `#6C6C6C`, `#E5E5E5`, `#FFFFFF`;
- ícones lineares monocromáticos;
- branco reservado para ações primárias e estados de maior ênfase.

A implementação no desktop V2 — tokens, tipografia empacotada, símbolo em SVG e o modelo de
interação do canvas — está em `docs/V2_VISUAL_SYSTEM.md`.

## Critérios usados na escolha

- pronunciável em português e inglês;
- GitHub org/repo disponível;
- domínio razoável;
- sem confusão com produtos de terceiros;
- não usar “AI” obrigatoriamente;
- CLI curta;
- busca diferenciável;
- marca verificável.

## Território verbal

- coordenar;
- construir;
- fluxo;
- equipe;
- palco;
- execução;
- evidência;
- controle.

## Copy inicial

### Headline

**Monte seu time. Execute em fluxo.**

### Subheadline

Terminais reais, Claude Code, Codex e materiais em um canvas local. Conecte contexto, coordene
agentes visíveis e assuma o controle quando quiser.

### CTA

- Ver como funciona
- Acompanhar a beta

## Posicionamento

Não vender “10x developer”. Vender:

- agentes e terminais reais em um workspace visual;
- menos repetição de contexto;
- operação visível e controlável;
- entrega validada e recuperável;
- liberdade de escolher o runtime;
- arquitetura local-first e open source.

## Guardrails de copy

- Pode usar “open source” quando a distribuição apontar para o código licenciado sob `AGPL-3.0-only` e respeitar `TRADEMARKS.md`.
- Não chamar forks ou builds de terceiros de releases oficiais do Compazio.
- Descrever Claude Code, Codex e OpenCode apenas de acordo com as capacidades realmente validadas na versão publicada.
- Não prometer worktree exclusiva por terminal.
- Distinguir claramente visão do produto e capacidade disponível na versão publicada.
- Não anunciar download, assinatura ou suporte multiplataforma validado sem artefato e evidência.
- Números de performance só entram na página com medição reproduzível registrada.
