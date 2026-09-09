# Segurança do Filesystem V2

O renderer não acessa `fs`. Todas as operações passam pelo `FileSystemService` no processo principal e por IPC validado.

- entradas são sempre relativas ao workspace;
- traversal, caminhos absolutos, UNC e bytes nulos são bloqueados;
- alvos existentes usam `realpath`; symlinks e junctions que escapam da raiz são recusados;
- leituras de texto e previews têm limite de tamanho;
- o editor aceita UTF-8 não binário;
- gravações usam arquivo temporário e rename atômico;
- uma revisão com hash, tamanho e mtime impede sobrescrita de mudança externa;
- exclusão da raiz é proibida e operações destrutivas exigem confirmação na interface.

Watchers são de runtime, um por árvore, com debounce e limpeza no fechamento/exclusão. `.git`, `node_modules` e `.compazio` não são percorridos pela busca leve.

## Trazer arquivos do computador

Uma pessoa pode trazer arquivos de qualquer lugar do computador para o canvas, pelo seletor nativo
do sistema ou arrastando do explorador. Isso não abre exceção no guarda de caminho — a exceção
valeria para agentes também.

- o seletor é aberto pelo processo principal e ancorado na pasta do workspace;
- um arquivo que já está dentro do workspace é referenciado onde está;
- um arquivo de fora é **copiado** para `.compazio/anexos` e o canvas aponta para a cópia, de modo
  que toda leitura posterior continua relativa ao workspace;
- nada é sobrescrito: um nome repetido recebe sufixo numérico;
- pastas são recusadas e o limite por arquivo é 50 MB;
- o renderer nunca vê um caminho absoluto: `importFiles` devolve caminhos relativos.

O caminho real de um arquivo arrastado vem de `webUtils.getPathForFile` no preload — o renderer não
tem acesso a `File.path` nem a `fs`.
