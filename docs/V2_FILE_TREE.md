# Árvore de Arquivos V2

`FileTreeNode` é um nó persistente do canvas. Cada árvore possui caminho atual, histórico, expansão, busca, modo de visualização, seleção, editor e estado de diff independentes.

Os caminhos persistidos são relativos ao workspace (`.` ou `src/app.ts`). A árvore carrega uma pasta por vez; não indexa o projeto inteiro. Lista, grade e diff permanecem dentro do nó para que o canvas continue sendo o centro da experiência.

Atalhos: `Ctrl+Shift+E` cria uma árvore; `Ctrl+S` salva no editor leve. Arquivos podem ser fixados pelo menu **Fixar** ou arrastados da árvore ao canvas.
