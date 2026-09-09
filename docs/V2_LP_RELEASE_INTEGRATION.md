# Contrato futuro com a Landing Page

Esta etapa não altera a Landing Page nem implementa pagamentos.

A LP poderá consumir `GET https://<project-ref>.supabase.co/functions/v1/release-current` e receber
somente `channel`, `version`, `platform`, `architecture`, `downloadUrl`, `metadataUrl`, `sha256`,
`sizeBytes`, `signed`, `releaseNotesUrl` e `publishedAt`. O download e o metadata são assets
públicos do GitHub Release; service role não é necessário no navegador.

Quando houver pagamento, o fluxo planejado é provedor de pagamento → webhook server-side → script de
emissão de licença → entrega do código. Não há webhook, checkout ou cobrança recorrente nesta
versão.
