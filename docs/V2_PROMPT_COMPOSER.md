# Prompt Composer V2

O compositor é uma camada opcional sobre um terminal existente. Ele não cria chat, sessão, agente ou histórico paralelo: ao enviar, o texto preparado é escrito no stdin da sessão real e a resposta continua no terminal.

Use `Ctrl+Shift+P` com um terminal selecionado, o botão **Compor prompt** ou o menu contextual do terminal. Contextos de notas, árvores, arquivos, previews e terminais aparecem como referências explícitas. Itens duplicados são enviados uma vez; itens indisponíveis são informados e não são enviados.

O compositor não persiste stdout, tokens ou credenciais. O tamanho exibido é a estimativa UTF-8 do texto que será enviado.
