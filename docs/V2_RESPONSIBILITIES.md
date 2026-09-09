# Responsabilidades

As responsabilidades internas são Desenvolvedor, Revisor, Testador, Documentação e Designer de Interface. Elas são imutáveis: podem ser duplicadas para uma versão do usuário, mas não alteradas ou removidas destrutivamente.

A biblioteca permite listar, buscar, criar, editar responsabilidades de usuário, duplicar, excluir, descobrir, importar e exportar. Uma responsabilidade usada por um terminal é opcional e registra o hash/revisão que foi aplicado; ela não pode ser excluída enquanto continuar atribuída, para evitar uma próxima inicialização inconsistente.

Formatos portáteis ficam em `<workspace>/.compazio/roles/<id>/role.json` e `instructions.md`. A descoberta não importa automaticamente, ignora symlinks e valida IDs/caminhos antes de ler. A importação não sobrescreve conflito de ID diferente; a exportação recusa sobrescrever arquivos existentes.

Antes do launch, `RoleInjectionService` cria `role-sessions/<workspace>/<terminal>-<session>/instructions.md` fora do repositório e passa caminho, ID, revisão e instruções por ambiente ao processo. Claude Code, Codex e OpenCode também recebem as instruções como entrada normal do terminal, sem flags não documentadas. Comandos personalizados recebem somente ambiente/arquivo; Shell não aceita responsabilidade, portanto texto algum é injetado como comando de shell. O artefato é removido ao encerrar, reiniciar ou excluir o terminal; cleanup é idempotente.
