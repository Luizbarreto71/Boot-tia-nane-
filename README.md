# Bot Tia Nane

Assistente virtual da **Janiere Gomes, Nutricionista e Personal Trainer**, que responde os clientes pelo WhatsApp oficial (Cloud API).

- **A IA (Claude) responde o texto livre.** Ela entende a pergunta, responde com os dados aprovados e registra a solicitação de atendimento. Quando é o caso, chama a Janiere e pausa o bot.
- **O código cuida do resto:** comandos (MENU, HUMANO, SAIR), números e botões do menu, assuntos bloqueados no WhatsApp, saudações, janela de 24h, consentimento e envio.
- **Resposta alternativa:** se a IA falhar, for recusada, demorar demais ou escrever algo que a política barraria, tudo o que ela fez no turno é desfeito e o menu automático responde.

Pendências e critérios de aceite: [PENDENCIAS.md](PENDENCIAS.md) · Elegibilidade: [docs/elegibilidade-canais.md](docs/elegibilidade-canais.md) · Fluxos: [docs/fluxos.md](docs/fluxos.md) · Prompt da assistente: [prompts/assistente-v1.md](prompts/assistente-v1.md)

## Restrição de canal

A política oficial do WhatsApp Business (atualizada em 23/09/2026) proíbe **“Multi-level marketing”**. No WhatsApp:

- **Renda extra, distribuidor e equipe ficam bloqueados** no menu, no texto livre, nas ferramentas da IA, nas respostas da IA e nas respostas da equipe.
- **Produtos ficam desligados** até haver uma avaliação documentada.
- **O bot atende** nutricionista on-line, personal trainer on-line e falar com a Janiere.

## Requisitos

- Node.js ≥ 22.12 e PostgreSQL 17. Nesta máquina eles não estão no PATH: `export PATH="/c/Users/User/tools/node:/c/Users/User/tools/pgsql/bin:$PATH"`.
- Para a IA: uma chave da API da Anthropic (`ANTHROPIC_API_KEY`).
- Para o WhatsApp real: app na Meta, número na WhatsApp Business Platform e URL pública HTTPS.

## Testar localmente (simulação)

```bash
cp .env.example .env              # preencha ANTHROPIC_API_KEY para ligar a IA
npm install
npm run db:start                  # Postgres local em localhost:54400
npm run sim                       # converse como se fosse um cliente
```

Sem chave, o simulador responde só pelo menu. Com chave, as chamadas à IA são **reais** (e cobradas pela Anthropic), mas nenhuma mensagem sai para o WhatsApp.

No terminal, cada resposta aparece como `bot (IA)`, `bot (menu)` ou `equipe`. Comandos do simulador: `/ajuda`, `/estado`, `/equipe`, `/assumir`, `/responder <texto>`, `/devolver`, `/tempo +25h`, `/repetir`, `/acao <id>`.

## Colocar no WhatsApp real

1. **Conta:** confirme que o número e o perfil representam a prática profissional da Janiere (ver [docs/elegibilidade-canais.md](docs/elegibilidade-canais.md)).
2. **Meta for Developers:**
   - crie o app (tipo Business) e adicione o produto WhatsApp;
   - registre o número;
   - gere um **token de acesso de sistema** permanente;
   - anote o **ID do número**, o **ID da conta (WABA)** e o **segredo do app**.
3. **Hospedagem no Render** (o arquivo `render.yaml` cria o serviço e o banco, em planos pagos):
   - no painel, escolha **New → Blueprint** e selecione este repositório;
   - preencha os valores pedidos: `ANTHROPIC_API_KEY`, `META_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN` (um texto que você escolhe), `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_BUSINESS_ACCOUNT_ID` e `PUBLIC_BASE_URL` (o endereço `https://….onrender.com` do serviço);
   - no serviço, em **Environment → Secret Files**, crie o arquivo `negocio.json` com o conteúdo de `config/negocio.exemplo.json`, ajustado com os dados aprovados da Janiere. Sem esse arquivo o serviço não inicia;
   - as migrações são aplicadas na inicialização.
4. **Webhook na Meta:**
   - URL `https://SEU-DOMINIO/webhook/whatsapp` e o mesmo `WHATSAPP_VERIFY_TOKEN`;
   - assine o campo **messages**.
5. **Teste:** mande mensagens de um número autorizado e confira as respostas e as tabelas `mensagens`, `envios` (status de entrega) e `auditoria` (`ia_turno`, `ia_falhou`).

O processo atende `GET /saude`, `GET` e `POST /webhook/whatsapp`. O webhook valida a assinatura HMAC, grava o evento e responde 200. Um laço contínuo processa os eventos, chama a IA, envia as respostas e refaz os envios que falharam.

## Testes

```bash
npm run typecheck
npm test            # unidade + integração (precisa do Postgres local); a IA é simulada por um modelo roteirizado
```

## Estrutura

```
prompts/          prompt de sistema da assistente (versionado)
src/agente/       turno da IA (loop de ferramentas), ferramentas, montagem do prompt, cliente Anthropic
src/conversa/     motor de menus (estado → respostas), roteamento motor × IA, comandos, intenções, textos
src/nucleo/       recebimento (transação + savepoint da IA), outbox, política de envio, atendimento humano, eventos do webhook
src/canais/       WhatsApp Cloud API (envio, assinatura, leitura do webhook) e simulação
src/servidor.ts   webhook (Fastify)          src/principal.ts  processo de produção (npm start)
config/           negocio.demo.json (demonstrativo); a configuração real fica fora do git
```

## Custos da IA

Padrão: `claude-opus-5-5` com esforço `low` (US$ 4 / 20 por milhão de tokens de entrada/saída, pela tabela de preços de 06/10/2026; confira a vigente em platform.claude.com). A parte fixa do prompt fica em cache. Para reduzir custo, use `ANTHROPIC_MODEL=claude-sonnet-5-5` ou `claude-haiku-5-5` no `.env`; avalie a qualidade antes de trocar. O consumo por turno (tokens e latência) fica na tabela `auditoria`, ação `ia_turno`.
