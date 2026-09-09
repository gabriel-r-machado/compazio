# Fluxos de usuário

## Primeira execução

1. Abrir o Compasso.
2. Adicionar uma pasta pelo diálogo nativo.
3. Abrir ou criar um canvas.
4. Ver os runtimes realmente disponíveis.
5. Escolher **Montar manualmente** ou **Começar com IA**.

CLI ausente gera orientação acionável e nunca é instalada silenciosamente. A autenticação continua
sob responsabilidade do CLI.

## Montar manualmente

1. Adicionar um Terminal, Claude Code, Codex, Nota ou Material.
2. Ao criar um agente, escolher apenas o runtime no caminho rápido.
3. Ajustar papel, permissões ou pasta somente quando necessário.
4. Conectar materiais e agentes.
5. Aceitar ou editar o contrato sugerido da conexão.
6. Adicionar um gate ou output.
7. Revisar o resumo e iniciar.

O usuário continua podendo digitar diretamente em qualquer terminal. “Manual” não exige copiar o
resultado entre agentes: conexões aprovadas podem executar passagens automáticas.

## Começar com IA

1. Escolher um agente-capitão instalado.
2. Descrever o resultado desejado.
3. Anexar materiais e selecionar o perfil.
4. O capitão recebe capabilities, políticas e snapshot do canvas.
5. O capitão cria um rascunho por ações estruturadas.
6. Nós em rascunho aparecem no canvas.
7. O usuário responde somente a dúvidas bloqueantes.
8. Revisa time, responsabilidades, permissões, estimativa e gates.
9. Aprova e inicia.

Se o capitão falhar, o rascunho permanece visível e editável. O produto não substitui a proposta por
um template genérico.

## Continuar um canvas manual com IA

1. Selecionar parte ou todo o canvas.
2. Escolher **Continuar com IA**.
3. Descrever o que precisa ser planejado, corrigido ou expandido.
4. O capitão recebe um snapshot versionado do estado existente.
5. Ele propõe adições e alterações sem apagar elementos do usuário.
6. O usuário revisa o diff visual e aprova.

## Assumir uma execução

1. Selecionar um agente em execução.
2. Pausar novas decisões daquela etapa.
3. Escolher **Assumir terminal**.
4. Digitar ou trabalhar normalmente.
5. Registrar uma decisão ou artefato quando necessário.
6. Escolher **Devolver ao workflow**.

Assumir o terminal não destrói o histórico nem libera dependentes automaticamente.

## Passagem automática em run formal

1. A etapa conclui com resultado estruturado.
2. O runtime verifica contrato e evidências.
3. Artefatos são publicados e versionados.
4. O Context Builder seleciona o necessário para o destino.
5. O scheduler libera a próxima etapa.
6. O destino recebe tarefa, decisões, restrições e referências.

Output bruto completo não é encaminhado por padrão.

## Handoff interativo

1. O usuário escolhe **Concluir e entregar** em uma sessão livre ou assistida.
2. Revisa o pacote estruturado.
3. Aprova o envio.
4. O destino recebe a entrega.

Esse fluxo continua humano por design e é distinto de uma dependência já aprovada dentro de um run.

## Falha e recuperação

1. O nó muda para um estado de falha compreensível.
2. A interface mostra causa, último evento e impacto.
3. O usuário escolhe entre tentar novamente, editar contexto, substituir runtime, assumir terminal,
   cancelar ou abrir detalhes.
4. Retry cria nova tentativa auditável.
5. Dependentes permanecem bloqueados até uma conclusão válida.

## Retomar depois

1. Reabrir o projeto.
2. Restaurar canvas, viewport, missão, papéis, contratos e último snapshot.
3. Sessão perdida aparece como interrompida, não como ativa.
4. Escolher reiniciar etapa, criar nova sessão, assumir manualmente ou cancelar.
5. Continuar sem duplicar entregas já confirmadas.

## Reutilizar o time

1. Selecionar agentes, materiais esperados, conexões e gates.
2. Salvar como perfil, time ou blueprint.
3. Em outro projeto, importar ou selecionar o item salvo.
4. Revisar runtimes, paths, permissões e materiais ausentes.
5. Adaptar manualmente ou pedir adaptação ao agente-capitão.
6. Aprovar antes de executar.
