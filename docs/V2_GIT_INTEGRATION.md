# Git contextual V2

`GitService` executa o binário `git` diretamente com `args[]`, timeout e `shell: false`. O repositório deve ter a mesma raiz canônica do workspace; um repositório pai não é operado silenciosamente.

O nó mostra branch, ahead/behind e mudanças. As operações expostas são status, diff, stage, unstage, commit, fetch, pull com fast-forward, push, checkout, criar branch, stash e aplicar/listar stash. Erros de instalação, autenticação, conflito e timeout são estruturados. Não há rebase visual, graph ou cliente GitHub nesta fase.
