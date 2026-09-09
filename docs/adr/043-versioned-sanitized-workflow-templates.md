# ADR 043 - templates de workflow versionados e sanitizados

## Contexto

Workflows internos confiaveis nao sao um formato seguro de intercambio. Um documento importado pode
conter executaveis, comandos, paths pessoais, SQL ou segredos, e nao pode se tornar executavel
apenas por ter sido aberto ou visualizado.

## Decisao

- O formato atual de template e `1.1`. Ele declara questionario, materiais obrigatorios e opcionais,
  agentes por papel, contratos, gates, permissoes e um DAG de workflow. IDs de template e workflow
  precisam coincidir; cada permissao de no e validada como subconjunto da permissao declarada.
- O preview aceita tambem o formato legado `1.0` e o migra somente em memoria para `1.1`. Perguntas
  e listas de materiais legadas sao convertidas para estruturas tipadas; o preview informa a migracao.
- A sanitizacao recusa campos de comando, executavel, argumentos, cwd, path, SQL e credenciais, alem
  de valores com formato de path pessoal ou segredo. O schema final e estrito e o DAG e validado.
- O checksum SHA-256 e calculado sobre a serializacao canonica do documento sanitizado. Um checksum
  fornecido por documento `1.1` deve coincidir. O preview retorna somente o documento sanitizado,
  checksum e avisos de migracao.
- O preview e exposto por IPC tipado, mas nao grava, registra ou executa o template. A execucao segue
  limitada aos templates confiaveis registrados pelo runtime desktop.

## Consequencias

O desktop pode mostrar uma importacao antes de qualquer persistencia futura, sem transportar paths,
comandos ou executaveis ao renderer e sem criar um segundo runtime. O formato e extensivel por novas
migrations explicitas; a importacao de pacotes `.compasso` continuara sendo um incremento separado.
