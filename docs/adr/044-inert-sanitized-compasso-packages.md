# ADR 044 - pacotes `.compasso` inertes e sanitizados

## Contexto

Um pacote compartilhavel nao pode carregar sessoes de terminal, caminhos pessoais, bytes de
artefatos, notas privadas, credenciais ou uma instrucao que inicie um workflow. O mesmo pacote
precisa representar template, workspace, fluxo ou fragmento sem confiar no conteudo importado.

## Decisao

- O envelope `.compasso` atual usa formato `1.0` e tipos `template`, `workspace`, `flow` e
  `fragment`. Todo pacote recebe checksum SHA-256 da serializacao canonica sanitizada.
- Um template delegado ao pacote passa pelo preview versionado do ADR 043. Workspaces, fluxos e
  fragmentos passam por uma projecao de canvas: mantem somente agentes, tasks, gates, formas,
  frames, comentarios, posicoes e dependencias estruturais. Terminais, notas, artefatos, fontes de
  contexto, papeis, permissoes, conteudo, resumo, missao, referencias de arquivo e rotulos livres
  sao removidos; os estados voltam a `idle`.
- A importacao valida campos estritos, reconstrui a projecao sanitizada e verifica checksum quando
  fornecido. O resultado e sempre um preview inerte, com aviso explicito de que aplicar ou executar
  exige uma acao futura separada.
- Os dois fluxos sao expostos somente por IPC tipado. Nenhum handler grava arquivo, persiste pacote,
  cria sessao, inicia run ou permite que o renderer defina comando, executavel, cwd ou SQL.

## Consequencias

O formato permite exportar e inspecionar uma representacao segura antes de qualquer importacao
materializada. Ele e compativel com a camada de arquivo ou dialogo nativo futura sem transformar o
conteudo externo em autoridade de execucao.
