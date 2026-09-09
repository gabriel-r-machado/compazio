# Escopo atual e próximo marco

## Status honesto

O Compasso está em **alpha interna local-first**. O repositório possui uma base técnica ampla, mas a
experiência central ainda não está comprovada de ponta a ponta. Existência de scheduler, canvas,
adapters e schemas não significa que montar um time e deixá-lo executar já seja simples e confiável.

`docs/23-current-capabilities.md` é a autoridade sobre capacidades implementadas.

## O que já existe

- desktop Electron e web opcional desacoplada;
- PTY local, shell, Claude Code, Codex e fake-agent;
- canvas persistido com múltiplos workspaces, terminais, agentes, notas e conexões;
- missão, papéis, contratos e handoffs interativos revisáveis;
- scheduler, DAG, eventos, artifacts e templates locais;
- serviços de projeto Git, worktree, diff, gates, merge confirmado e rollback;
- SQLite, migrations, policies, logger com redaction, flags e IPC tipado;
- bases em desenvolvimento para rascunho de workflow, orquestrador e perfis de execução;
- PT-BR padrão e English opcional;
- cloud e billing atrás de flags e desligados por padrão.

## Próximo marco: vertical slice do produto

O próximo marco não é adicionar mais peças isoladas. É provar este fluxo em um projeto local:

1. abrir o projeto;
2. adicionar materiais;
3. criar dois agentes reais no canvas com defaults simples;
4. atribuir responsabilidades e conectar as entregas;
5. aprovar e iniciar o workflow;
6. executar a primeira etapa;
7. produzir um artefato estruturado;
8. liberar a etapa seguinte automaticamente por conclusão verificável;
9. executar um quality gate real;
10. mostrar resultado, falha ou recuperação no canvas;
11. fechar e reabrir sem perder o estado;
12. salvar o time para reutilização.

O mesmo fluxo deve passar primeiro com o fake-agent/shell e depois com um adapter real.

## Segundo marco: composição com IA

Depois que o vertical slice manual estiver confiável:

1. escolher um agente-capitão instalado;
2. descrever um objetivo;
3. fornecer snapshot e capabilities do canvas;
4. receber um rascunho criado por protocolo estruturado;
5. editar e aprovar no canvas;
6. executar pela mesma infraestrutura do marco anterior;
7. alternar de volta ao controle manual sem perder estado.

Não criar um runtime paralelo para “Automático”.

## Terceiro marco: perfis e economia

- implementar Econômico, Padrão e Alta Performance como políticas reais;
- limitar contexto por relevância sem remover o obrigatório;
- registrar métricas reais quando disponíveis e estimativas quando não;
- aplicar mudança de perfil somente a tarefas futuras;
- comparar qualidade, latência e consumo no mesmo workflow de referência.

## Critérios de saída

- nenhum erro silencioso;
- nenhum workflow genérico usado como fallback;
- nenhum estado derivado apenas de texto de terminal;
- terminais permanecem utilizáveis durante e depois do run;
- reload preserva o estado do workflow;
- falha mostra causa e ação segura;
- handoff automático carrega somente o contexto contratado;
- ao menos um workflow reutilizado com sucesso em outro projeto;
- lint, typecheck, testes, integração, build e smoke relevantes passam.

## Fora deste marco

- IDE completa;
- modelo próprio;
- cloud obrigatória;
- colaboração multiplayer;
- remote runners;
- marketplace;
- suporte simultâneo a todas as CLIs;
- merge ou deploy autônomo;
- instaladores públicos sem assinatura e evidência;
- promessa de autonomia irrestrita.

## Regra de prioridade

Até o vertical slice estar confiável, novas iniciativas devem ser classificadas assim:

1. **bloqueia o ciclo principal** — fazer agora;
2. **melhora diretamente simplicidade, confiança ou recuperação** — próximo;
3. **expande casos de uso sem provar o ciclo** — adiar;
4. **cloud, monetização ou crescimento** — manter desligado.
