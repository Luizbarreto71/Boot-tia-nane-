# Especificação dos fluxos

Implementação: `src/conversa/motor.ts`, uma função pura `(estado, entrada, contexto) → (estado, respostas, efeitos)`. Os textos ficam em `src/conversa/textos.ts`.

## Quem responde: motor ou IA

`destinoDaEntrada` (no motor) decide. Com a IA ligada:

- **Ficam com o motor:**
  - comandos globais;
  - ações de listas e botões;
  - números e opções da pergunta pendente;
  - assuntos bloqueados no canal;
  - saudações e agradecimentos;
  - mídia;
  - um nome válido na coleta de nome;
  - o assunto do pedido de atendimento.
- **Vão para a IA:** o resto do texto livre, inclusive no primeiro contato e números sem pergunta pendente.

Turno da IA (`src/agente/agente.ts`, chamado de `src/nucleo/recebimento.ts`):

1. Abre um savepoint na transação da conversa.
2. Envia ao modelo:
   - o prompt versionado;
   - os dados aprovados e as restrições do canal (em cache);
   - o contexto do turno;
   - o histórico **desta** conversa (últimas 24 mensagens entregues, incluindo as da equipe).
3. Loop de ferramentas, com até 4 chamadas ao modelo e 4 ferramentas, e prazo de 45 s. As ferramentas são:
   - `registrar_solicitacao_atendimento`;
   - `solicitar_atendimento_humano`;
   - `mostrar_menu`.

   Elas recebem a identidade do contato do servidor e revalidam tudo (serviço habilitado, nome, opções, tema).
4. A resposta final é barrada se estiver vazia, longa demais, apresentar a assistente como a Janiere ou falhar na política de envio (tema bloqueado). Nesse caso, ou em erro, recusa ou limite: rollback do savepoint, auditoria `ia_falhou` e o motor responde a mesma mensagem.
5. Em sucesso: auditoria `ia_turno` (modelo, versão do prompt, ferramentas, tokens, latência). A conversa volta para `livre`, ou para o menu, se a IA pediu `mostrar_menu`.

## Persona

- Assistente virtual da Janiere Gomes, Nutricionista e Personal Trainer, em português do Brasil. Nunca diz “sou a Janiere” nem afirma que alguém assumiu o atendimento.
- Tom acolhedor e objetivo, poucos emojis, **uma pergunta por mensagem**.
- Formato, preço e prazo só aparecem quando vêm da configuração aprovada (`revisao` preenchida). Em arquivo demonstrativo, a resposta sai marcada como `[dado demonstrativo]`.
- Sem preço configurado: “O valor é informado diretamente pela Janiere.”
- O horário nunca é confirmado. O bot registra uma solicitação, e a Janiere combina o horário com a pessoa.
- Não coleta histórico clínico, não diagnostica e não prescreve. A avaliação individual cabe à profissional.

## Comandos globais (valem em qualquer etapa)

| Entrada | Efeito |
|---|---|
| `SAIR`, `PARAR`, `STOP`, “não quero mais receber…”, “me descadastra” | Revoga acompanhamento e marketing e cancela as tarefas pendentes. Não reinicia a conversa. |
| “cancelar o agendamento”, “desmarcar a consulta” | Registra o pedido de cancelamento e avisa a equipe. **Não é descadastro.** |
| `cancelar` (sozinho) | Dentro de um fluxo: encerra o pedido em andamento. Fora de fluxo: pergunta se a pessoa quer cancelar um atendimento combinado. |
| `HUMANO`, `JANIERE`, “falar com a Janiere/uma pessoa” | Abre o atendimento humano e pausa a automação. |
| `MENU`, `INÍCIO` | Mostra o menu do canal (sem repetir as boas-vindas). |
| `VOLTAR` | Volta para a etapa anterior (pilha de até 12 passos); sem histórico, mostra o menu. |

## Etapas

`livre` → `menu` → `servico` → `coleta_nome` → `coleta_contato` → `coleta_periodo` → `confirmacao` → `livre`.
Auxiliares: `esclarecimento` (ambiguidade), `assunto_humano`, `oferta_humano` e `confirmar_cancelamento`.

- **Números** são interpretados só pela pergunta pendente (`estado.pergunta`). Sem pergunta pendente, “1” não vira uma opção do menu.
- **Ações interativas** carregam `p<idDaPergunta>:<número>`. Um id diferente da pergunta atual (menu antigo ou forjado) é recusado e a pergunta atual é repetida. O id é crescente e nunca é reiniciado, nem quando a equipe devolve a conversa.
- **Texto nas opções:** a resposta pode bater exatamente com o rótulo ou um alias (“sim”, “ligação”), ou mencionar uma única opção como palavra inteira (“por ligação”). Frases com “não” ou que citam mais de uma opção não escolhem nada. Na etapa de período, “manhã ou tarde” e “a partir das 18h” viram horário livre.
- **Texto livre** (menu, livre, esclarecimento, serviço):
  - um assunto elegível abre o fluxo;
  - dois assuntos elegíveis geram uma pergunta curta de esclarecimento;
  - um assunto não elegível no canal recebe a resposta neutra e volta ao menu.
- **Falhas de entendimento:** a primeira repete a pergunta; a segunda oferece falar com a Janiere. Saudação e agradecimento não contam como falha.
- **Boas-vindas:** só na primeira mensagem (`conversas.boas_vindas_em`). Se essa primeira mensagem já tiver um assunto claro, o fluxo começa direto.

## Atendimento humano

1. A pessoa pede o atendimento por comando, pela opção 7 (com o assunto) ou depois de duas falhas.
2. O sistema cria o `atendimento` com motivo, resumo (incluindo as restrições do canal) e responsável padrão. Avisa a equipe (`notificacoes_equipe`), muda a conversa para `controle=humano` e cancela as tarefas pendentes.
3. Com o bot pausado, as mensagens são gravadas e avisadas à equipe, sem resposta automática. O descadastro continua valendo.
4. A equipe pode assumir (operador ativo; só um admin transfere um atendimento que já tem responsável), responder (só o responsável ou um admin, passando pela política de envio) e devolver ao bot (só o responsável ou um admin, com nota de resultado).
5. Fora do expediente configurado, o bot diz isso. Prazo de retorno só aparece se estiver configurado.

## Persistência e envio

Ver `src/nucleo/recebimento.ts` e `src/nucleo/envio.ts`.

- **Uma transação por mensagem recebida:** cria ou atualiza o contato (identificado pelo canal, nunca por dado do texto), trava a conversa (`FOR UPDATE`, o que serializa as mensagens da mesma conversa), deduplica pelo id do provedor, roda o motor, aplica os efeitos e grava o estado e o outbox.
- **Despacho depois do commit:**
  - a política é reavaliada (janela de 24h, módulo e tema do canal);
  - uma mensagem nunca ultrapassa outra mais antiga da mesma conversa;
  - falha comum volta para a fila com recuo exponencial, até 3 tentativas;
  - falha definitiva vira `falhou`;
  - timeout ou interrupção vira `incerto` e não é repetido automaticamente.
