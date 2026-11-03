# Pendências

Situação em 28/10/2026: a IA responde os clientes e o canal oficial do WhatsApp está implementado. Tudo foi testado localmente; **nada foi testado contra a Meta nem contra a API real da Anthropic** (não há credenciais nesta máquina).
Legenda: **[owner]** decisão ou dado da Janiere ou do responsável · **[externo]** configuração em provedor · **[técnico]** implementação.

## Para o bot responder clientes reais

1. **[owner] Chave da Anthropic** (`ANTHROPIC_API_KEY`). Com ela, dá para testar a IA já no simulador (`npm run sim`).
2. **[owner] Identidade da conta WhatsApp.** O número e o perfil devem representar a prática profissional da Janiere (nutrição e personal trainer), sem oferta de negócio Herbalife. A política do WhatsApp vale para o negócio da conta, não só para as mensagens. Ver [docs/elegibilidade-canais.md](docs/elegibilidade-canais.md).
3. **[externo] Meta:** app Business com WhatsApp, número registrado, token de sistema, ID do número, ID da WABA, segredo do app e webhook apontando para `/webhook/whatsapp` com o campo `messages`. Passo a passo no README.
4. **[owner] Hospedagem no Render:** criar o Blueprint a partir de `render.yaml` (passo a passo no README).
5. **[técnico] Atendimento humano em produção — bloqueia o uso com clientes reais.** Quando alguém pede a Janiere, o bot pausa a conversa, mas em produção ainda não existe tela nem aviso para ela assumir, responder e devolver. Sem isso, essa conversa fica sem resposta. As ações já existem no núcleo; falta a caixa de entrada.
6. **[owner] Configuração real** (Secret File `negocio.json` no Render, a partir de `config/negocio.exemplo.json`):
   - formato e valor dos serviços, com `revisao` (quem aprovou, data, fonte);
   - expediente e prazo de retorno;
   - perguntas frequentes aprovadas;
   - operadores (pelo menos a Janiere como admin).

   Sem esses dados, a IA diz que a Janiere informa diretamente; ela não inventa.

## Decisões ainda abertas

- **[owner] Produtos no WhatsApp:** hoje estão desligados. Opções: manter fora, ou pedir uma avaliação documentada (Business Policy + Commerce Policy).
- **[owner] Fluxos de negócio** (renda extra, distribuidor, equipe): só em outro canal. A proposta é um chat no site próprio, se houver necessidade real.
- **[owner] Caixa de entrada:**
  - hoje a equipe assume, responde e devolve pelo núcleo (testado e usado no simulador);
  - ainda não há tela com login para a Janiere;
  - os avisos para a equipe ficam na tabela `notificacoes_equipe` e ainda não chegam ao celular dela.
- **[owner] Modelo da IA:** o padrão é `claude-opus-5-5`; Sonnet ou Haiku ficam mais baratos. Convém comparar com conversas reais antes de trocar.

## Próximas implementações

- [técnico] Caixa de entrada mínima autenticada (conversas, assumir, responder, devolver, registrar resultado) e aviso à Janiere quando um atendimento for pedido.
- [técnico] Modelos de mensagem (templates) aprovados, para falar fora da janela de 24h. Hoje, fora da janela, nada sai.
- [técnico] Acompanhamentos D+1/D+3/D+7 (desligados), com consentimento explícito e nunca para recrutamento no WhatsApp.
- [técnico] Leitura de áudio e imagem. Hoje o bot avisa que só lê texto.
- [técnico] Métricas a partir da `auditoria`: contatos por interesse, encaminhamentos, solicitações, conversões verificadas, descadastros, falhas, latência e tokens da IA.
- [técnico] Conjunto de avaliação com conversas reais (anonimizadas) para medir a qualidade das respostas da IA antes de mudar o prompt ou o modelo.
- [técnico] Retenção e expurgo de dados configuráveis, e limite de taxa por contato.

## Critérios de aceite: situação

| Critério | Situação |
|---|---|
| Números e ações respeitam o estado; reiniciar não perde a conversa | ✅ |
| Evento repetido não gera nova resposta | ✅ (deduplicação pelo id da mensagem do WhatsApp) |
| Eventos de status não acionam o bot | ✅ (status atualiza só o envio) |
| Assinatura inválida é rejeitada | ✅ (HMAC-SHA256 sobre o corpo bruto, comparação em tempo constante) |
| Perda de persistência não é confirmada como sucesso | ✅ (webhook responde 500) |
| Assumir pausa bot e tarefas; devolver exige ação autorizada | ✅ (inclusive quando a IA abre o atendimento) |
| Descadastro cancela acompanhamentos; atendimento posterior não reativa marketing | ✅ |
| Envio fora da janela bloqueado (bot, humano, tarefa) | ✅ |
| Módulos incompatíveis bloqueados no menu, no texto livre, nas ferramentas e nas respostas da IA | ✅ |
| Ausência de preço ou agenda não gera informação inventada | ✅ no motor; na IA, o prompt e os dados dizem “não informado”. A qualidade real só se mede com a IA de verdade (ver avaliação acima) |
| Falha da IA tem resposta alternativa controlada | ✅ (erro, recusa, limite de chamadas ou saída barrada → savepoint desfeito → menu) |
| Instruções maliciosas não revelam dados nem mudam configurações | ✅ no código: ferramentas sem identificador de contato, histórico só da conversa, configuração fora do alcance da IA. O comportamento do modelo diante de ataques precisa de teste com a API real |
| Uma pessoa não acessa dados de outra | ✅ |
| Credenciais não aparecem nos logs | ✅ (testado e conferido no log do servidor) |
| Solicitação ou declaração de cadastro não conta como conversão verificada | ✅ |
