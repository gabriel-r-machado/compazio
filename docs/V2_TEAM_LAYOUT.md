# Auto-layout de equipes

O layout é determinístico e executado no recrutamento, quando uma nota
compartilhada entra na equipe ou por ação explícita. Ele nunca roda por byte de
terminal nem reorganiza o canvas inteiro.

## Estratégia

- Orquestrador permanece como âncora;
- recrutas ocupam linhas de até três nós abaixo da âncora;
- notas compartilhadas ficam na lateral ou após as linhas;
- dimensões reais e espaçamentos entram no cálculo;
- nós externos e posições manuais são obstáculos;
- busca em anéis encontra a posição livre mais próxima;
- múltiplas equipes usam seus próprios IDs e layouts.

Mover um nó adiciona seu ID a `manualNodeIds`. Recrutamentos seguintes preservam
essa posição. “Organizar equipe” mantém personalizações; “Restaurar layout
automático” usa confirmação e `force: true`.

As ações “Enquadrar equipe” e “Centralizar no Orquestrador” usam bounds
calculados e não alteram posições.

## Desempenho

O teste representativo executa 100 layouts de uma equipe de 10 terminais cercada
por 20 notas e exige menos de 500 ms no total. O layout não depende das 30
arestas visuais. Atualizações de terminal trafegam por um bus separado, com
buffer de 200 KiB por sessão, evitando rerender global a cada byte.

Medição local de 28/07/2026: 1.000 execuções do mesmo cenário em 28,70 ms
(0,0287 ms por layout). No Electron real, expandir e persistir o cenário de 10
terminais, 20 notas e 30 conexões levou 1.005,9 ms; uma amostra de 60 frames com
esse canvas levou 1.442,4 ms (24,0 ms por frame). O cenário é restaurado em uma
abertura separada antes da medição.
