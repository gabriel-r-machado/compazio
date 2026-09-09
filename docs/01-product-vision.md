# Visão do produto — fonte de verdade

Este documento define o objetivo e as fronteiras do produto. PRD, UX, arquitetura, roadmap e
implementação devem ser avaliados contra ele.

## North star

> Ser o workspace visual local-first em que uma pessoa monta, executa e reutiliza times de agentes
> usando terminais reais, materiais e validações no mesmo canvas, sem perder o controle da operação.

## Promessa

> Monte o time no canvas. Execute em fluxo. Assuma o controle quando quiser.

## Resultado que vendemos

O Compazio não vende “mais agentes” nem “mais terminais”. Ele vende a capacidade de transformar um
objetivo e seus materiais em uma entrega de software coordenada, verificável e recuperável, usando
as ferramentas que a pessoa já escolheu.

## Modelo mental

### O canvas é o ambiente

O canvas é o espaço contínuo no qual o trabalho acontece. Ele contém terminais reais, agentes,
materiais, notas, artefatos, tarefas, gates, aprovações e outputs. Não é apenas uma projeção bonita
de um workflow escondido.

### Os agentes do usuário são o time

Claude Code, Codex, OpenCode, shells e futuros runtimes são instalados e autenticados pelo usuário.
O Compazio não possui uma IA embutida e não depende de um fornecedor no domínio.

### O runtime é a operação

O runtime controla estados, dependências, filas, permissões, limites, handoffs, validações,
persistência e recuperação. Um agente pode propor decisões; nunca é a fonte de verdade do estado.

### Artefatos são a memória de trabalho

Agentes não devem receber automaticamente todo o histórico bruto. Cada etapa consome o objetivo,
decisões, restrições, materiais e artefatos relevantes ao seu contrato. Isso reduz custo, ruído e
perda de consistência.

## Dois eixos independentes

### Forma de composição

- **Montar manualmente:** a pessoa cria terminais, escolhe runtimes, conecta materiais e define
  responsabilidades com defaults úteis.
- **Montar com IA:** um agente-capitão já instalado recebe o objetivo e usa ferramentas estruturadas
  do Compazio para propor um workflow editável.

O motor é híbrido por design: as duas formas de composição rodam no mesmo scheduler determinístico e
compartilham o mesmo canvas. No build padrão, porém, apenas **Montar manualmente** é exposto — o
seletor de modo fica atrás da feature flag `automaticWorkflow` (desligada por padrão) até a
composição com IA estar pronta para uso geral. Nada do motor automático foi removido; religar a flag
devolve o toggle e o fluxo completo sem perder trabalho.

“Manual” descreve quem monta e orienta o time. Não significa copiar mensagens entre terminais nem
executar cada passagem à mão. Depois de iniciada, uma sequência configurada pode rodar
automaticamente.

### Perfil de execução

- **Econômico:** menos agentes, contexto enxuto, validações essenciais e reparo sob demanda.
- **Padrão:** equilíbrio entre especialização, custo, revisão e qualidade; é o default.
- **Alta Performance:** mais especialização, paralelismo seguro, crítica independente e repair loop
  mais profundo.

O perfil altera a política de trabalho futura, não somente um rótulo ou o modelo escolhido. Nunca
remove contexto obrigatório, reduz segurança ou modifica tarefas que já começaram.

## Experiência essencial

1. Abrir um projeto local.
2. Descrever o resultado desejado.
3. Adicionar arquivos, pastas, imagens, documentos, links e notas.
4. Montar o time ou pedir uma proposta a um agente-capitão.
5. Entender rapidamente quem faz o quê, o que recebe e o que deve entregar.
6. Aprovar e iniciar.
7. Acompanhar cada terminal real trabalhando dentro do canvas.
8. Pausar, assumir, orientar, reconectar ou substituir uma etapa.
9. Validar o resultado com evidências adequadas.
10. Salvar o time ou blueprint para reutilização.

## Jobs to be Done

- “Quero coordenar vários agentes sem copiar contexto entre janelas.”
- “Quero ver e usar terminais normais dentro do mesmo canvas.”
- “Quero montar um time uma vez e reaproveitá-lo em novos projetos.”
- “Quero que um agente meu proponha o workflow sem fingir que o produto tem IA própria.”
- “Quero escolher entre economia e profundidade sem configurar dezenas de campos.”
- “Quero dividir um trabalho grande entre especialistas sem receber uma colagem inconsistente.”
- “Quero entrar em qualquer terminal e corrigir o rumo sem perder o histórico do fluxo.”
- “Quero saber por que uma execução parou e conseguir retomá-la com segurança.”

## Princípios inegociáveis

1. **Canvas como centro:** terminais e materiais permanecem visíveis, manipuláveis e conectáveis.
2. **Terminais reais:** shell livre continua disponível; automação não remove interatividade.
3. **Um canvas híbrido:** Manual e Com IA não são produtos ou áreas isoladas — mesmo quando Com IA
   está desligado por feature flag no build padrão, ambos compartilham o mesmo scheduler e o mesmo
   canvas assim que reativado.
4. **BYOA:** a inteligência vem dos agentes instalados e autenticados pelo usuário.
5. **Engine determinístico:** estado não é inferido de frases, silêncio ou encerramento do PTY.
6. **Contexto explícito:** conexões definem acesso e contratos; não concedem comportamento oculto.
7. **Entrega estruturada:** artefatos, decisões e evidências passam adiante no lugar do histórico bruto.
8. **Simplicidade por fora:** defaults, sugestões e progressive disclosure escondem a robustez interna.
9. **Controle reversível:** pausar, assumir, editar, retomar e recuperar são capacidades fundamentais.
10. **Local-first:** projeto, sessões, prompts, output e segredos permanecem locais por padrão.
11. **Qualidade comprovada:** texto do agente não substitui arquivo, diff, exit code, teste ou gate.
12. **Fornecedor substituível:** nenhum runtime específico contamina o domínio.

## Coerência entre especialistas

Dividir tarefas só melhora o resultado quando existe um contrato global. Em trabalhos paralelos, os
agentes devem compartilhar decisões e restrições comuns, trabalhar em escopos isolados e passar por
integração e validação. “Um agente por seção” sem direção comum produz uma colagem e não cumpre a
promessa do produto.

## Reutilização

O produto deve permitir três níveis, em ordem de complexidade:

1. **Perfil de agente:** runtime, função, regras e capacidades.
2. **Time salvo:** conjunto de perfis e relações recorrentes.
3. **Blueprint:** workflow versionado com materiais esperados, tarefas, gates e políticas.

Templates aceleram o início, mas uma proposta criada por IA precisa adaptar o time ao objetivo real.
Prompts materialmente diferentes não podem resultar silenciosamente no mesmo workflow genérico.

## Segurança e autonomia

O usuário pode aprovar a execução de um workflow inteiro sem aprovar cada passagem segura. Ainda
assim, o produto deve pausar para:

- permissão ausente;
- login ou interação externa;
- ação destrutiva;
- conflito Git;
- merge ou deploy não previamente autorizado;
- orçamento ou limite excedido;
- ambiguidade que altere materialmente o resultado;
- falha que não possua recuperação segura.

Controle humano não significa microgerenciamento obrigatório.

## Não objetivos

- ser uma IDE completa;
- desenvolver ou hospedar um modelo próprio;
- revender tokens no núcleo local;
- controlar o modo automático por digitação temporizada em um PTY;
- tratar output bruto como protocolo ou conclusão;
- deixar agentes ampliarem as próprias permissões;
- copiar a experiência visual de produtos de referência;
- exigir cloud, conta, billing ou telemetria;
- suportar todas as stacks e todos os runtimes antes de provar um fluxo completo;
- automatizar merge, deploy ou ação destrutiva sem autorização explícita.

## Teste de alinhamento

Antes de priorizar uma iniciativa, responda:

1. Ela fortalece o canvas como ambiente real de trabalho?
2. Reduz configuração ou repetição para montar o time?
3. Melhora contexto, coordenação, confiabilidade ou recuperação?
4. Preserva terminais reais e a possibilidade de intervenção?
5. Funciona sem criar dependência de uma IA própria?
6. Pode ser explicada como parte do ciclo `montar → executar → acompanhar → validar → reutilizar`?

Se a maioria das respostas for “não”, a iniciativa está fora do eixo do produto.
