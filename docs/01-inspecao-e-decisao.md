# Etapa 1 — Inspeção e decisão

Data: 28/10/2026.

## Fatos verificados

| Item | Situação encontrada |
|---|---|
| Repositório, stack, inbox ou integração do Bot Tia Nane | **Não existiam.** O único projeto na máquina é o MIVORA (loja Next.js + Supabase), sem relação com este bot. |
| Runtime disponível | Node.js 22.23 (linha 22 = LTS em manutenção até abr/2027) e PostgreSQL 17.6, em `C:\Users\User\tools`. |
| Política do WhatsApp Business | Lida em 28/10/2026 na fonte oficial (business.whatsapp.com/policy, que redireciona para whatsappbusiness.com/policy). **Atualizada em 23/09/2026.** A seção 4 lista **“Multi-level marketing”** e **“Medical and healthcare products”**, e diz que as proibições valem “irrespective of the global or local licenses, registrations, or other approvals”. |
| Mesma política, seção 2 | Fora da janela de 24h só podem ser enviados modelos aprovados. A janela “abre e reinicia a cada mensagem do usuário”. A automação deve oferecer escalonamento humano “pronto, claro e direto”. |
| Mesma política, seção 1 | Contato só com número fornecido **e** opt-in. Pedidos de descadastro precisam ser respeitados. |
| Dados do negócio (número, links, preços, catálogo, agenda, materiais) | **Ausentes.** Ficam como campos de configuração; nada foi inventado. |

## Decisões tomadas nesta etapa (propostas; ajustáveis)

1. **Stack:** Node.js + TypeScript + PostgreSQL (`pg`) + Zod + Vitest. **Fastify** (webhook) e o **SDK oficial da Anthropic** entram na etapa 3, quando houver webhook e interpretação por IA. Nesta etapa eles não teriam uso.
2. **Aplicação modular única**, organizada por responsabilidade:
   - `dominio`: módulos e elegibilidade;
   - `conversa`: motor puro, comandos, intenções e textos;
   - `nucleo`: transação, outbox e atendimento humano;
   - `canais`: adaptadores;
   - `db`: banco e migrações;
   - `sim`: simulador.
3. **O código controla** menus, estado, elegibilidade, consentimento e envio. A interpretação de texto livre é **determinística por palavras-chave** nesta etapa. A IA virá como reforço, sempre depois do roteador e sob as mesmas regras.
4. **A elegibilidade fica em código** (`src/dominio/elegibilidade.ts`). A configuração do negócio pode desligar um módulo permitido, mas não consegue ligar um bloqueado.
5. **Outbox desde o início:** toda saída (bot ou humana) é gravada junto com o estado e reavaliada pela política no despacho.
6. **Um perfil hipotético `canal_proprio`, apenas para simulação**, preserva o menu de referência de 7 opções. Ele não é um canal implementado.
7. **Postgres local próprio** na porta 54400, para não interferir no Postgres local do MIVORA (porta 54322).

## Incompatibilidades de canal (resumo)

Detalhes, fontes e a proposta de canal próprio estão em [elegibilidade-canais.md](elegibilidade-canais.md).

- **Bloqueados no WhatsApp:** renda extra, distribuidor e equipe/royalties (seção 4, “Multi-level marketing”). O bloqueio vale para o menu, o texto livre, o assunto do atendimento humano e as respostas da equipe.
- **Pendente de avaliação no WhatsApp:** produtos Herbalife. Ficam desligados por padrão.
- **Elegíveis no WhatsApp:** nutricionista on-line, personal trainer on-line e falar com a Janiere. Mesmo assim, o owner precisa confirmar a elegibilidade **da conta** (ver o documento).

## Dados pendentes

Ver [../PENDENCIAS.md](../PENDENCIAS.md).
