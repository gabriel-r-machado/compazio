# ADR 045 — seleção de contexto indexada e reproduzível

## Contexto

O Context Builder (ADR 030) já reunia somente fontes alcançáveis por uma aresta direta `context`.
Entretanto, toda fonte conectada seguia para o checkpoint, sem uma política explícita de inclusão,
modo de consumo, prova de por que cada fonte foi escolhida ou estimativa local de tamanho.

## Decisão

- Cada fonte de contexto pode declarar `required`, `relevant`, `optional` ou `never`. A conexão
  direta continua sendo a primeira condição de acesso; `never` sempre vence e não entra no contexto
  efetivo, mesmo quando existe uma aresta direta.
- `context_source_indexes` e `context_index_chunks` persistem somente tipo, origem estrutural,
  versão, hash, tamanho e limites de chunk. Eles não duplicam conteúdo, paths locais, bytes de
  artefatos, comandos ou credenciais.
- O seletor é determinístico e tem três modos: `full` inclui tudo exceto `never`; `intelligent`
  inclui obrigatório e relevante, adicionando opcionais até um orçamento estável; `economical`
  preserva obrigatório, limita relevantes por orçamento e exclui opcionais. A ordenação é por ID
  estrutural da fonte, logo a mesma entrada produz o mesmo resultado.
- A chave do cache é o hash dos índices, do agente e do modo. Alterar hash, política, versão ou
  modo gera outra chave, sem reutilizar uma seleção obsoleta. O snapshot de seleção com todas as
  razões de inclusão/exclusão é parte do checkpoint imutável.
- Tokens são estimados localmente a partir dos chunks. `actualTokens`, custo real e moeda ficam
  nulos até que um provider reporte valores verificáveis; enquanto isso, o status de custo é sempre
  `estimated`.

## Consequências

`compasso context build` e `compasso run start` aceitam `--context-mode full|intelligent|economical`.
O modo é durável no comando de run e reaplicado em retry/alternativa. A UI permite configurar a
política de fontes no menu contextual, mas não concede permissões: Policy Engine e arestas diretas
continuam sendo a fonte de autorização.

Os checkpoints históricos sem `contextSelection` permanecem legíveis. As tabelas novas são aditivas
e não reprocessam dados existentes até que um contexto seja construído novamente.
