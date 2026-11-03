# Elegibilidade por canal

Fonte: WhatsApp Business Policy (https://business.whatsapp.com/policy), **atualizada em 23/09/2026** e lida em **28/10/2026**.
**Revalidar antes da integração real** e a cada mudança de política. Esta análise trata da compatibilidade com a plataforma, não da legalidade da empresa.

A matriz executável está em `src/dominio/elegibilidade.ts`. Este documento e aquele arquivo mudam juntos.

## Matriz de funções no WhatsApp

| Id estável | Função (menu de referência) | Status no WhatsApp | Fundamento |
|---|---|---|---|
| `renda_extra` | 1. Oportunidade de renda extra | **Bloqueado** | Seção 4: “Multi-level marketing”. |
| `distribuidor` | 2. Quero ser distribuidor(a) Herbalife | **Bloqueado** | Seção 4: “Multi-level marketing”. |
| `produtos` | 3. Quero conhecer os produtos | **Pendente de avaliação (desligado)** | A venda faz parte de um modelo multinível, e há possível enquadramento em “Medical and healthcare products” (seção 4). Falta uma avaliação documentada, também à luz da Commerce Policy. |
| `equipe` | 4. Quero crescer e desenvolver minha equipe | **Bloqueado** | Seção 4: “Multi-level marketing”. |
| `nutricao` | 5. Nutricionista on-line | Habilitado | Serviço profissional. O fluxo não coleta histórico clínico, não diagnostica e não prescreve. |
| `personal` | 6. Personal Trainer on-line | Habilitado | Serviço profissional. O fluxo não monta treino individual. |
| `falar_janiere` | 7. Falar diretamente com Janiere | Habilitado | É o caminho de escalonamento humano exigido pela seção 2. **O atendimento humano mantém as restrições acima.** |

### Onde o bloqueio é aplicado (não só no menu)

- **Menu:** o WhatsApp mostra só 3 opções, numeradas 1–3. Os ids internos não mudam.
- **Texto livre:** frases como “quero ser distribuidora”, “renda extra”, “royalties”, “produtos” ou “herbalife” recebem uma resposta neutra (“não é atendido por este canal”), voltam ao menu, ficam auditadas e **não geram interesse registrado**.
- **Assunto do atendimento humano:** se o motivo contém um tema bloqueado, o atendimento não é aberto.
- **Respostas da equipe:** a mesma política de envio barra, por exemplo, “Que tal ser distribuidora?”.
- **Despacho:** cada mensagem é reavaliada antes de sair (defesa em profundidade).
- **Resumo do atendimento:** a equipe recebe a lista do que não pode tratar neste canal.

Limitação conhecida: a detecção de tema é por palavras-chave. Ela barra os casos explícitos, mas não substitui a orientação da equipe. Uma revisão por IA das respostas humanas pode ser adicionada na etapa 3.

## Elegibilidade da conta (decisão do owner)

As proibições valem para o **negócio**, não só para as mensagens. Se a conta WhatsApp Business for apresentada como distribuição Herbalife (perfil, descrição, catálogo, site vinculado), a conta inteira corre risco, mesmo que o bot só trate nutrição.

Recomendação:
- registrar o número e o perfil como a **prática profissional da Janiere** (nutrição e personal trainer on-line);
- não incluir oferta de negócio Herbalife no perfil, no catálogo nem no site vinculado.

**Pendente:** confirmação do owner sobre a identidade da conta. Sem essa confirmação, a etapa 3 (integração real) não deve ser ativada.

## Proposta para os módulos de negócio (renda extra, distribuidor, equipe)

Requisito: preservar esses fluxos sem usar o WhatsApp para eles. Mudar palavras, mandar um link externo pelo WhatsApp ou passar para atendimento humano **não resolvem** a incompatibilidade. Também não se usa automação por QR Code nem WhatsApp Web.

Opções, da menor para a maior:

1. **Não automatizar agora (recomendado para o MVP).** Os fluxos ficam especificados e testáveis no perfil de simulação `canal_proprio`. Nada é publicado.
2. **Chat no site próprio da Janiere**, como novo adaptador (`web`) do mesmo núcleo. O perfil `canal_proprio` vira real e ganha opt-in próprio. Custo: um endpoint HTTP e um widget simples, sem produto novo. Condições:
   - a entrada não pode vir de mensagens do WhatsApp;
   - antes, é preciso verificar as regras da própria Herbalife para divulgação on-line por distribuidores;
   - a política de qualquer plataforma que direcione tráfego para lá também precisa ser verificada.
3. Outros canais (e-mail, outras plataformas de mensagens): cada um tem políticas próprias, que precisariam de verificação. Não há avaliação feita.

A opção 2 só se justifica se o owner confirmar que precisa automatizar esses fluxos. Os materiais oficiais e os links de cadastro verificados também precisam estar disponíveis antes.

## Perfil `canal_proprio` (apenas simulação)

- Mostra o menu completo de 7 opções, na ordem de referência.
- Não aplica a janela de 24h nem o bloqueio de tema.
- É recusado pelo núcleo quando `simulacao=false`.
- Os fluxos de negócio respondem “[SIMULAÇÃO] ainda não implementado” e não registram nada.
