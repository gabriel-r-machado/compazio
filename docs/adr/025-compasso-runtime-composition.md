# ADR 025 — composição independente do Compasso Runtime

Status: aceito

## Contexto

O processo principal do desktop havia acumulado a composição de supervisor de terminal, ponte de
agentes e dispatchers de mensagens, criação de agentes e projeções persistidas. Isso dificultava
separar o runtime local da janela e não definia a posse quando duas instâncias tentavam atender o
mesmo projeto.

Os locks de `project_leases` já existentes protegem uma operação Git curta (por exemplo, merge). Eles
não representam a vida de uma instância do runtime e não podem ser reutilizados sem bloquear ações
Git legítimas enquanto agentes estão ativos.

## Decisão

`CompassoRuntime` é a composição sem dependência de Electron ou renderer. Ele recebe portas de
processo, armazenamento e publicação tipada; o desktop fornece callbacks para a janela e a CLI
continua cliente local autenticado do mesmo SQLite/registro de runtime. Não foi criado um segundo
modelo de dados nem uma API remota de execução.

A migration `0020_wandering_doctor_faustus.sql` adiciona `runtime_project_leases`, com uma chave única
por projeto. Antes de registrar o runtime no manifesto do projeto, o desktop adquire o lease. Outra
instância não substitui o registro nem inicia dispatchers quando algum projeto já é atendido. O
encerramento normal interrompe os dispatchers, encerra os processos de terminal e então libera os
leases.

## Consequências

- desktop e CLI permanecem clientes do mesmo runtime local e dos mesmos dados duráveis;
- um runtime não concorre silenciosamente com outro pelo mesmo projeto;
- o lease de runtime não interfere no lock transitório de Git;
- recuperação de leases após encerramento anormal, estados operacionais e filas por projeto são
  incrementos posteriores do runtime; esta etapa não inicia scheduler, planejamento autônomo,
  equipes automáticas nem execução autônoma.
