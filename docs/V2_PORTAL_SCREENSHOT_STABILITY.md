# Estabilidade de screenshots do Portal

No Windows, o Electron pode rejeitar `WebContents.capturePage()` enquanto um `WebContentsView`
acabou de ser anexado ou repintado. Também pode devolver uma imagem vazia quando a superfície de
display ainda não está disponível.

`PortalRuntimeManager` trata somente esses sinais conhecidos como transitórios:

- `UnknownVizError`;
- `Current display surface not available for capture`;
- `PORTAL_SCREENSHOT_EMPTY`.

A captura é repetida no máximo três vezes, com 75 ms entre tentativas, sempre dentro do timeout e do
`AbortSignal` da operação. Falhas de captura não relacionadas não são repetidas. Cada retry registra
apenas metadados operacionais sanitizados: estado do Portal, bounds, visibilidade da superfície,
estado da janela, estado de carregamento e milissegundos desde a última atualização de bounds.

Validação real nesta branch:

- as duas primeiras execuções anteriores falharam no screenshot `op-33`;
- após a correção, três execuções consecutivas da integração passaram 40/40;
- smoke Electron de Portal passou 8/8;
- nenhum screenshot, operação ou recurso nativo ficou órfão.
