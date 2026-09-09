# ADR 010: handoffs explícitos e revisados no canvas

- Status: aceito
- Data: 2026-07-19

## Contexto

O Compasso já mantém sessões interativas de shell, Claude Code e Codex no canvas. A implementação
anterior podia usar o encerramento bem-sucedido do PTY como sinal para encaminhar parte do buffer
ao próximo terminal. Esse sinal não representa conclusão: CLIs interativas podem continuar abertas
depois de entregar uma resposta, encerrar por motivos alheios à tarefa ou produzir texto que não
deve ser compartilhado integralmente.

O canvas também já persiste missão, papel de cada terminal e contrato das conexões. Falta uma
fronteira explícita entre a conversa interativa e uma entrega revisável, além de histórico local
que permita saber exatamente o que foi aprovado e enviado.

## Decisão

O avanço entre terminais depende de uma ação humana chamada **Concluir e entregar**. O fluxo cria
um pacote estruturado, permite revisão e edição e somente então registra o evento
`handoff_ready`. Encerrar um PTY, detectar uma frase de sucesso ou observar silêncio no terminal
nunca produz esse evento.

O pacote aprovado contém snapshots de:

- missão global;
- papel do terminal de origem e do terminal de destino;
- contrato da conexão;
- resumo obrigatório;
- trabalho concluído, decisões, evidências e questões ou riscos em aberto.

O buffer bruto pode ser consultado localmente como referência durante a revisão, mas não é salvo,
não preenche automaticamente o pacote e não é enviado por padrão.

O modo inicial é **Manual — revisar antes de enviar**. Depois da aprovação, o processo principal
compõe uma mensagem fechada usando dados persistidos e a escreve na sessão de destino. O renderer
envia apenas IDs tipados; não escolhe executável, argumentos, comando ou caminho.

## Persistência e estados

Handoffs do canvas usam tabelas próprias, separadas dos handoffs de runs formais do scheduler. Isso
evita inventar um `workflowRun` ou `nodeRun` para uma sessão interativa.

O estado segue:

```text
draft -> ready -> delivering -> delivered
                           \-> failed
```

Uma entrega encontrada em `delivering` após reinicialização passa a `delivery_unknown`. O sistema
não reenvia automaticamente porque não consegue provar se a escrita no PTY ocorreu antes do
crash. O usuário pode revisar o histórico e tentar novamente de forma explícita.

Cada transição relevante gera um evento local ordenado. Revisões concorrentes usam a versão do
registro para rejeitar gravações obsoletas, e ações repetidas sobre uma entrega já concluída não
duplicam o envio.

## Consequências

- A conclusão fica auditável sem fingir que o terminal produz saída estruturada confiável.
- O usuário controla o conteúdo compartilhado e pode remover segredos ou ruído.
- A entrega pode exigir que a sessão de destino seja iniciada antes do envio.
- Automação autônoma, inferência de conclusão e retry silencioso ficam fora desta fase.
- O `ProcessSupervisor`, o lifecycle do PTY, os adapters e o scheduler permanecem inalterados; uma
  porta estreita de escrita reutiliza a sessão já existente.

## Não objetivos

- resumir automaticamente todo o terminal;
- decidir qual agente deve trabalhar em seguida;
- conceder permissões, trocar branch ou criar worktree durante um handoff;
- prometer entrega exatamente uma vez através de uma falha de processo;
- oferecer OpenCode como adapter funcional.
