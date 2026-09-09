# Especificação UX/UI

## Princípio

O canvas é o produto. A robustez deve estar no runtime; a interface deve começar simples e revelar
configurações somente quando forem úteis.

> O usuário deve sentir que controla um ambiente de trabalho vivo, não que preenche um editor de DAG.

## Entrada principal

```text
O que você quer construir?
[________________________________________________]

Projeto      [ Escolher pasta ]
Materiais    [ Adicionar ]
Qualidade    [ Econômico | Padrão | Alta Performance ]

[ Montar manualmente ]   [ Começar com IA ]
```

As duas ações abrem o mesmo canvas. Elas não criam áreas, arquivos ou runtimes incompatíveis.

## Hierarquia da interface

1. canvas e terminais;
2. objetivo, materiais e estado do trabalho;
3. ações contextuais do elemento selecionado;
4. detalhes avançados sob demanda;
5. histórico e diagnósticos quando necessários.

Evitar dashboard permanente, formulários longos antes do primeiro terminal e painéis duplicados.

## Elementos iniciais

- Terminal de shell;
- Terminal de agente;
- Nota;
- Material de arquivo/pasta/imagem;
- Artefato;
- Aprovação;
- Gate;
- Grupo;
- Output.

Tipos internos adicionais podem existir no engine sem aumentar a paleta inicial.

## Terminal como cidadão de primeira classe

Cada terminal deve ser:

- real e interativo;
- arrastável e redimensionável;
- associado a uma pasta de trabalho visível;
- capaz de mostrar runtime, papel e estado;
- utilizável livremente fora de um run;
- acompanhável durante automação;
- assumível pelo usuário;
- preservado após falha para inspeção.

A interface pode oferecer comportamentos Livre, Assistido, Workflow e Supervisor, mas deve
apresentá-los como níveis de coordenação do mesmo terminal, não como emuladores diferentes.

## Progressive disclosure

### Criação rápida de agente

Obrigatório:

- runtime.

Derivado por default:

- nome;
- pasta;
- perfil;
- permissões seguras;
- papel inicial.

Avançado:

- modelo;
- argumentos permitidos;
- orçamento;
- capabilities;
- contrato;
- estratégia de contexto;
- worktree.

### Conexão

Ao conectar dois elementos, mostrar uma frase clara:

```text
Diretor de arte entrega direção visual para Frontend.
```

Detalhes sob demanda:

- inputs;
- outputs;
- critérios;
- fontes de contexto;
- gatilho manual ou automático;
- evidências;
- retry.

Linhas nunca concedem permissão oculta ou iniciam execução sozinhas.

## Composição com IA

O agente-capitão deve aparecer como um terminal real no canvas. O composer é uma forma mais simples
de conversar com essa sessão, não um chatbot interno do Compasso.

Durante a proposta:

- mostrar o que o agente está analisando;
- projetar ghost nodes conforme o rascunho evolui;
- destacar dúvidas realmente bloqueantes;
- permitir editar e bloquear campos;
- mostrar runtimes indisponíveis, permissões e estimativas;
- separar **Aprovar workflow** de **Iniciar execução** quando houver risco material.

## Execução

Cada nó deve comunicar estado por texto, forma e cor:

- aguardando;
- preparando;
- executando;
- precisa de você;
- validando;
- corrigindo;
- concluído;
- falhou;
- cancelado.

Ações contextuais:

- pausar;
- assumir terminal;
- enviar orientação;
- devolver ao workflow;
- tentar novamente;
- substituir agente;
- ver contexto;
- ver artefatos;
- cancelar.

Não usar animação contínua ou logs brutos como única indicação de progresso.

## Entrada por objetivo

A ação principal do Compazio não é “compor prompt” nem “criar equipe”. É entregar um objetivo. A
caixa deve usar a sequência de produto abaixo como contrato de UX:

`Objetivo → Plano → Equipe → Prompts → Contexto → Execução → Acompanhamento → Correção → Entrega`

A pessoa descreve somente o resultado esperado. O Compazio escolhe agentes, funções, prompts e
dependências. Durante uma missão, a mesma caixa vira **Ajustar missão**: a pessoa descreve a mudança,
o Compazio calcula o impacto e o Coordinator mantém a revisão depois do trabalho alterado. Perguntas
de workers aparecem e são respondidas nessa superfície; nunca é necessário localizar o terminal de
um agente.

## Perfis

O seletor Econômico/Padrão/Alta Performance deve explicar impacto em linguagem de produto:

- **Econômico:** até um worker; combina execução e validação essencial quando razoável.
- **Padrão:** até dois workers; permite Builder + Reviewer independente.
- **Alta Performance:** até três workers; permite Research/UX, Builder e Reviewer quando necessário.

Esses números são tetos de autonomia, não templates obrigatórios. O Compazio continua escolhendo a
menor equipe suficiente e nunca cria QA apenas porque há capacidade livre.

Configurações técnicas ficam no detalhe. Troca durante execução informa claramente que afeta somente
tarefas futuras.

## Reutilização

Após uma execução bem-sucedida, oferecer:

- salvar este agente;
- salvar este time;
- salvar como blueprint.

Na próxima criação, sugerir itens relevantes sem substituir silenciosamente o objetivo atual.

## Direção visual

- superfícies escuras, bordas discretas e tipografia legível;
- terminais visualmente fortes sem dominar o canvas inteiro;
- conexões claras e sem excesso de decoração;
- foco visível e movimento funcional;
- evitar aparência de dashboard SaaS genérico;
- não copiar marca, assets ou composição de concorrentes.

## Acessibilidade

- foco visível e ordem de tabulação previsível;
- labels acessíveis para ícones;
- status expresso por texto e forma, não apenas cor;
- redução de movimento respeitada;
- terminal mantém seleção, cursor e tamanho de fonte legíveis;
- menus, proposta, aprovação e recuperação operáveis por teclado.

## Copy pública

A copy deve vender coordenação, confiança e reutilização. Não anunciar como pronta uma capacidade que
existe apenas na visão ou em desenvolvimento. Use `docs/23-current-capabilities.md` como limite.
