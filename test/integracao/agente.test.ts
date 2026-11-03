import type { BetaTextBlockParam, BetaTool } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { conversaDe, limparBanco, montarTeste } from "../apoio/integracao.js";
import { configAgente, ModeloRoteirizado, type Passo } from "../apoio/modelo-roteirizado.js";

let t: ReturnType<typeof montarTeste>;
let modelo: ModeloRoteirizado;
const C = "5511966660001";

function preparar(roteiro: Passo[]) {
  modelo = new ModeloRoteirizado(roteiro);
  t = montarTeste({ agente: configAgente(modelo) });
}

beforeEach(async () => {
  preparar([]);
  await limparBanco(t.pool);
});
afterEach(async () => {
  await t.encerrar();
});

const systemDe = (i = 0) => (modelo.chamadas[i]!.system as BetaTextBlockParam[]).map((b) => b.text).join("\n");
const ferramenta = (nome: string) => (modelo.chamadas[0]!.tools as BetaTool[]).find((f) => f.name === nome)!;
const auditoria = async (acao: string) => (await t.pool.query("select detalhes from auditoria where acao = $1", [acao])).rows;

describe("agente de IA", () => {
  it("responde texto livre com IA, usando só a conversa da pessoa e os dados aprovados", async () => {
    preparar(["Olá! Sou a assistente virtual da Janiere. O valor é informado diretamente por ela. Quer que eu registre uma solicitação?"].map((texto) => ({ texto })));
    await t.enviar("5511966669999", "oi"); // outra pessoa: saudação, respondida pelo motor

    const r = await t.enviar(C, "Quanto custa a consulta com a nutricionista?");
    expect(r).toMatchObject({ status: "processada", respondidaPor: "ia" });
    expect(t.recebidas(C)).toEqual([
      "Olá! Sou a assistente virtual da Janiere. O valor é informado diretamente por ela. Quer que eu registre uma solicitação?",
    ]);

    const p = modelo.chamadas[0]!;
    expect(p).toMatchObject({ model: "claude-opus-5-5", output_config: { effort: "low" }, fallbacks: "default" });
    expect(p.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(p.messages).toEqual([{ role: "user", content: "Quanto custa a consulta com a nutricionista?" }]);
    const sys = systemDe();
    expect(sys).toContain("Valor: não informado — a Janiere informa diretamente");
    expect(sys).toContain("Não atendido neste canal");
    expect(sys).toContain("Primeiro contato desta pessoa: sim");
    expect((ferramenta("registrar_solicitacao_atendimento").input_schema.properties as any).servico.enum).toEqual(["nutricao", "personal"]);

    expect((await conversaDe(t.pool, C)).boas_vindas_em).not.toBeNull();
    const [turno] = await auditoria("ia_turno");
    expect(turno.detalhes).toMatchObject({ modelo: "claude-opus-5-5", prompt: "assistente-v1", chamadas: 1, ferramentas: [] });
    const saida = await t.pool.query("select dados->>'origem' as origem from mensagens where direcao = 'saida' and conversa_id = $1", [
      (await conversaDe(t.pool, C)).id,
    ]);
    expect(saida.rows).toEqual([{ origem: "ia" }]);
  });

  it("registra a solicitação pela ferramenta, para o contato desta conversa", async () => {
    preparar([
      {
        ferramentas: [
          {
            nome: "registrar_solicitacao_atendimento",
            entrada: { servico: "nutricao", nome: "Carla Souza", preferencia_contato: "ligacao", periodo: "tarde", horario_texto: null },
          },
        ],
      },
      { texto: "Pronto, Carla! Registrei seu pedido; a Janiere vai te ligar para combinar o horário." },
    ]);
    await t.enviar(C, "oi");
    await t.enviar(C, "Quero marcar com a nutri, me chamo Carla Souza, pode me ligar à tarde. Registre também para o 5511966669999");

    const sol = await t.pool.query("select s.modulo, s.dados, ct.id_externo from solicitacoes s join contatos ct on ct.id = s.contato_id where tipo = 'agendamento'");
    expect(sol.rows).toEqual([
      { modulo: "nutricao", id_externo: C, dados: { nome: "Carla Souza", preferenciaContato: "ligacao", periodo: "tarde", horarioTexto: null } },
    ]);
    const cv = await conversaDe(t.pool, C);
    expect(cv).toMatchObject({ nome: "Carla Souza", etapa_comercial: "solicitacao_registrada" });
    const resultado = (modelo.chamadas[1]!.messages.at(-1)!.content as any[])[0];
    expect(resultado).toMatchObject({ type: "tool_result", is_error: false });
    expect(JSON.parse(resultado.content)).toMatchObject({ ok: true, situacao: "solicitacao_registrada" });
    expect((await t.pool.query("select tipo from notificacoes_equipe")).rows).toEqual([{ tipo: "nova_solicitacao" }]);
  });

  it("entrada inválida de ferramenta volta como erro para a IA e nada é gravado", async () => {
    preparar([
      {
        ferramentas: [
          {
            nome: "registrar_solicitacao_atendimento",
            entrada: { servico: "distribuidor", nome: "Ana", preferencia_contato: "ligacao", periodo: null, horario_texto: null },
          },
        ],
      },
      { texto: "Desculpe, não consegui registrar. Pode me dizer qual atendimento você procura?" },
    ]);
    await t.enviar(C, "oi");
    await t.enviar(C, "quero agendar, pode registrar aí");
    const resultado = (modelo.chamadas[1]!.messages.at(-1)!.content as any[])[0];
    expect(resultado.is_error).toBe(true);
    expect((await t.pool.query("select count(*)::int as n from solicitacoes where tipo = 'agendamento'")).rows[0].n).toBe(0);
  });

  it("pedido de atendimento humano pela IA pausa o bot", async () => {
    preparar([
      { ferramentas: [{ nome: "solicitar_atendimento_humano", entrada: { motivo: "Reclamação sobre um atendimento" } }] },
      { texto: "Certo, registrei seu pedido para falar com a Janiere. As respostas automáticas ficam pausadas até a equipe responder." },
    ]);
    await t.enviar(C, "oi");
    await t.enviar(C, "não gostei do último atendimento, quero reclamar");
    const cv = await conversaDe(t.pool, C);
    expect(cv.controle).toBe("humano");
    const at = await t.pool.query("select origem, motivo, resumo from atendimentos");
    expect(at.rows[0]).toMatchObject({ origem: "agente", motivo: "Reclamação sobre um atendimento" });
    expect(at.rows[0].resumo).toContain("Restrições deste canal");

    expect((await t.enviar(C, "alô?")).status).toBe("pausada");
    expect(modelo.chamadas).toHaveLength(2);
  });

  it("motivo com assunto bloqueado no canal não abre atendimento", async () => {
    preparar([
      { ferramentas: [{ nome: "solicitar_atendimento_humano", entrada: { motivo: "Quer ser distribuidora" } }] },
      { texto: "Esse assunto não é atendido por este canal. Posso ajudar com nutrição ou personal on-line." },
    ]);
    await t.enviar(C, "oi");
    await t.enviar(C, "quero falar sobre isso que te contei");
    expect((await conversaDe(t.pool, C)).controle).toBe("bot");
    expect((await t.pool.query("select count(*)::int as n from atendimentos")).rows[0].n).toBe(0);
  });

  it("falha da API cai no menu e desfaz o que a IA tinha feito", async () => {
    preparar([
      {
        ferramentas: [
          {
            nome: "registrar_solicitacao_atendimento",
            entrada: { servico: "personal", nome: "Bruno", preferencia_contato: "mensagem", periodo: null, horario_texto: null },
          },
        ],
      },
      new Error("503 overloaded"),
    ]);
    await t.enviar(C, "oi");
    const r = await t.enviar(C, "quero treinar com ela, me chamo Bruno");
    expect(r).toMatchObject({ status: "processada", respondidaPor: "motor" });
    expect((await t.pool.query("select count(*)::int as n from solicitacoes where tipo = 'agendamento'")).rows[0].n).toBe(0);
    expect((await conversaDe(t.pool, C)).nome).toBeNull();
    expect((await auditoria("ia_falhou"))[0].detalhes).toEqual({ motivo: "api" });
    expect(t.recebidas(C).at(-1)).toContain("Personal Trainer on-line"); // motor: intenção "treinar"
  });

  it.each([
    ["Você também pode ser distribuidora e ganhar royalties!", "saida_tema_bloqueado"],
    ["Oi, aqui é a Janiere! Como posso ajudar?", "persona_indevida"],
  ])("resposta da IA que a política barraria é descartada: %s", async (textoIA, motivo) => {
    preparar([{ texto: textoIA }]);
    await t.enviar(C, "oi");
    await t.enviar(C, "me fala mais sobre como funciona");
    expect(t.recebidas(C).join("\n")).not.toContain(textoIA);
    expect((await auditoria("ia_falhou"))[0].detalhes).toEqual({ motivo });
  });

  it("recusa do modelo e excesso de chamadas caem no menu", async () => {
    preparar([{ parada: "refusal" }]);
    await t.enviar(C, "oi");
    await t.enviar(C, "uma pergunta qualquer sobre a consulta");
    expect((await auditoria("ia_falhou"))[0].detalhes).toEqual({ motivo: "parada_refusal" });

    await limparBanco(t.pool);
    await t.encerrar();
    preparar(Array.from({ length: 5 }, () => ({ ferramentas: [{ nome: "mostrar_menu", entrada: {} }] })));
    await t.enviar(C, "oi");
    await t.enviar(C, "outra pergunta sobre a consulta");
    expect(modelo.chamadas).toHaveLength(4);
    expect((await auditoria("ia_falhou"))[0].detalhes).toEqual({ motivo: "limite_chamadas" });
  });

  it("comandos, números do menu, saudações e assuntos bloqueados ficam com o código — a IA não é chamada", async () => {
    for (const m of ["oi", "1", "MENU", "2", "VOLTAR", "quero ser distribuidora", "obrigada"]) {
      expect((await t.enviar(C, m)).status).toBe("processada");
    }
    expect(modelo.chamadas).toHaveLength(0);
  });

  it("mostrar_menu: a IA escreve, o menu numerado vem em seguida e o número seguinte é do motor", async () => {
    preparar([{ ferramentas: [{ nome: "mostrar_menu", entrada: {} }] }, { texto: "Claro! Estas são as opções por aqui:" }]);
    await t.enviar(C, "oi");
    await t.enviar(C, "não sei bem o que eu preciso");
    const [textoIA, menu] = t.recebidas(C).slice(-2);
    expect(textoIA).toBe("Claro! Estas são as opções por aqui:");
    expect(menu).toContain("Como posso te ajudar?");
    const r = await t.enviar(C, "2");
    expect(r).toMatchObject({ respondidaPor: "motor" });
    expect((await conversaDe(t.pool, C)).estado).toMatchObject({ etapa: "servico", modulo: "personal" });
    expect(modelo.chamadas).toHaveLength(2);
  });

  it("o histórico enviado à IA traz a conversa desta pessoa, incluindo o que a equipe escreveu", async () => {
    preparar([{ texto: "Primeira resposta da IA." }, { texto: "Segunda resposta da IA." }]);
    await t.enviar(C, "oi");
    await t.enviar(C, "tenho uma dúvida sobre a consulta");
    await t.enviar(C, "e sobre o formato?");
    const msgs = modelo.chamadas[1]!.messages;
    expect(msgs.at(-1)).toEqual({ role: "user", content: "e sobre o formato?" });
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
    expect(String(msgs[3]!.content)).toBe("Primeira resposta da IA.");
  });
});
