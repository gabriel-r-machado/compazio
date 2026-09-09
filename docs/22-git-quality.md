# Git, worktrees e quality gates

## Limites de confiança

O renderer não recebe uma API genérica de Git, filesystem ou processos. A seleção do repositório
usa o diálogo nativo no processo principal. Depois disso, o renderer envia somente IDs, chaves de
tarefa e presets fechados validados por Zod. Caminhos de worktrees gerenciadas, comandos, args e
refs não atravessam o IPC como entrada do renderer.

Cada projeto é validado por `git rev-parse`, resolvido para seu caminho canônico e precisa ter pelo
menos um commit. Worktrees são criadas somente sob o diretório gerenciado do `userData`, em uma
branch técnica `forgedeck/<slug>-<task-key>` baseada no commit imutável da branch padrão.

## Concorrência e locks

- uma lease atômica por worktree impede duas execuções de código no mesmo diretório;
- gates, merge e outras operações que executam código precisam adquirir a lease;
- merge também adquire um lock exclusivo do projeto;
- locks reais do Git são consultados antes de cleanup ou merge;
- leases e gates que ficaram ativos após encerramento são recuperados como interrompidos na
  inicialização.

O desktop usa lock de instância única. O PID de cada gate ativo é persistido separadamente. Na
recuperação, a lease só é liberada quando o PID não existe mais. Se o PID ainda estiver em uso e o
ownership não puder ser provado com segurança, Compasso não o encerra às cegas: preserva a lease
e mantém a worktree bloqueada, evitando tanto concorrência quanto matar um processo não relacionado.

O SQLite persiste projetos, worktrees, leases, execuções de gates, planos de merge e relatórios.
As tabelas de auditoria registram estado, commit, exit code, duração, timeout e saída redigida.

## Quality gates

Compasso descobre somente scripts conhecidos no `package.json`: `lint`, `typecheck`, `test`,
`build` e `playwright`. Playwright é opcional; os quatro primeiros são obrigatórios quando
disponíveis. O renderer escolhe um preset, nunca um comando livre.

O runner não usa shell, separa executable e args, valida `cwd`, aplica allowlist de ambiente,
limita a saída, redige secrets e encerra a árvore de processos em timeout. Uma frase do agente
nunca vira evidência: um gate válido exige processo realmente concluído com exit code zero,
duração registrada e o mesmo HEAD que será entregue.

## Revisão, merge e rollback

O painel **Runs** mostra dirty state, locks, arquivos, patch limitado, gates e seus resultados. O
relatório PR-ready é Markdown local com objetivo, arquivos, gates, conflitos, riscos e rollback.

Merge nunca ocorre durante preparação. O fluxo é:

1. preparar e revalidar worktree, target, conflitos e gates do HEAD;
2. receber um token efêmero válido por dez minutos;
3. digitar a branch de origem e confirmar explicitamente;
4. confirmar novamente no diálogo nativo do processo principal;
5. revalidar tudo sob locks exclusivos;
6. executar merge `--no-ff` sem apagar branch ou worktree.

Se o merge falhar, Compasso tenta abortá-lo e preserva os dois lados. Para desfazer um merge já
concluído sem reescrever histórico compartilhado:

```bash
git revert -m 1 <merge-commit>
```

Cleanup também exige confirmação nativa e lease exclusiva. Ele recusa worktree dirty, leased,
bloqueada ou com arquivos ignorados, inclusive `.env`. A API pública não oferece force cleanup.

## Testes Git reais

Os testes de integração criam repositórios temporários e cobrem paths com espaços, branch já
existente, lease concorrente, lock Git, dirty cleanup, conflito, gates reais, redaction, merge
confirmado e rollback. A matriz de CI está configurada para repetir lint, typecheck, testes,
migration e build em Windows, macOS e Linux. Isso não substitui o registro de uma execução real.

## Limite do canvas

Essas capacidades não significam que cada terminal visual recebe automaticamente uma worktree.
Isolamento só existe quando o fluxo Git explícito cria a worktree e adquire sua lease. Terminais
abertos diretamente no mesmo projeto podem compartilhar o mesmo diretório de trabalho.
