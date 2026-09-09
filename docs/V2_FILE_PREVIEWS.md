# Previews de Arquivo V2

`FilePreviewNode` persiste apenas caminho relativo, tipo, revisão opcional e estado `missing`; não persiste buffers, object URLs ou thumbnails.

Imagens suportadas recebem data URL limitada e SVG passa por sanitização de scripts, eventos e referências externas. Texto recebe preview limitado. PDF e vídeo possuem fallback seguro contextual: o conteúdo não é executado dentro do Compazio. Quando o arquivo desaparece, o nó permanece e mostra **Arquivo não encontrado**.
