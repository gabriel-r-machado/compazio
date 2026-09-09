# ADR 046 — backups SQLite antes de migrations

## Contexto

Migrations do banco local são aditivas e transacionais, mas uma falha de ambiente, energia ou uma
mudança futura incorreta ainda precisa de uma forma verificável de recuperar os dados anteriores.
Copiar um arquivo SQLite que está em WAL não é uma estratégia segura, e substituir silenciosamente
o banco ativo pode esconder perda de dados.

## Decisão

- Antes de uma migration pendente em um banco já inicializado, o processo local cria um snapshot
  consistente com `VACUUM INTO` em um diretório de backup derivado do banco local.
- O snapshot é aberto em modo somente leitura e precisa passar em `integrity_check` antes da
  migration continuar. Falhar ao criar ou verificar o backup interrompe a migration.
- Bancos novos e aberturas sem migration pendente não criam cópias desnecessárias.
- A recuperação é explícita, verifica novamente o snapshot e só pode copiar para um arquivo de
  destino inexistente. Ela nunca sobrescreve o banco ativo, não roda automaticamente e não é
  exposta ao renderer, IPC ou CLI.

## Consequências

O desktop preserva um ponto de recuperação antes de alterar um banco existente, sem introduzir uma
superfície genérica de filesystem. Suporte ou uma futura interface de recuperação deve parar o
runtime, pedir confirmação humana, restaurar para uma cópia separada e validar o resultado antes de
qualquer troca manual do banco ativo.

Backups não substituem exportação, criptografia de disco, retenção administrada pelo usuário ou uma
política de rollback de release. Não há rollback silencioso de schema.
