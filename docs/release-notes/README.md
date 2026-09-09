# Release notes

Cada candidata de beta precisa de um arquivo de release notes com versão, canal (`beta` ou
`stable`), commit, migrations incluídas, alterações visíveis, riscos, limitações e resultado real dos
três jobs de plataforma. O manifest de checksums é produzido pelo pipeline de release; ele não ativa
auto-update nem transforma um artefato não assinado em assinado.

Não publique uma release que alegue assinatura, notarização, compatibilidade de plataforma ou
rollback sem a evidência correspondente.
