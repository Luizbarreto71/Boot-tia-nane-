import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ErroAtendimento,
  ErroEnvioBloqueado,
  ErroPermissao,
  assumirAtendimento,
  devolverAoBot,
  responderComoOperador,
} from "../../src/nucleo/atendimento.js";
import { conversaDe, criarOperadores, criarTarefaPendente, limparBanco, montarTeste } from "../apoio/integracao.js";

let t: ReturnType<typeof montarTeste>;
let ops: Awaited<ReturnType<typeof criarOperadores>>;
const CONTATO = "5511988880001";

beforeEach(async () => {
  t = montarTeste();
  await limparBanco(t.pool);
  ops = await criarOperadores(t.pool);
});
afterEach(async () => {
  await t.encerrar();
});

async function pedirHumano() {
  await t.enviar(CONTATO, "oi");
  await t.enviar(CONTATO, "1");
  await t.enviar(CONTATO, "HUMANO");
  return (await conversaDe(t.pool, CONTATO)).id as string;
}

describe("atendimento humano", () => {
  it("HUMANO registra o pedido com resumo e responsável, avisa a equipe e pausa bot e tarefas", async () => {
    await t.enviar(CONTATO, "oi");
    await criarTarefaPendente(t.pool, CONTATO, t.agora());
    const conversaId = await (async () => {
      await t.enviar(CONTATO, "1");
      await t.enviar(CONTATO, "HUMANO");
      return (await conversaDe(t.pool, CONTATO)).id;
    })();

    const at = await t.pool.query("select status, origem, motivo, resumo, responsavel_id from atendimentos where conversa_id = $1", [
      conversaId,
    ]);
    expect(at.rows[0]).toMatchObject({ status: "solicitado", origem: "comando", motivo: "Pediu atendimento humano", responsavel_id: ops.janiere });
    expect(at.rows[0].resumo).toContain("Fluxo: Nutricionista on-line");
    expect(at.rows[0].resumo).toContain("Restrições deste canal");

    const tarefas = await t.pool.query("select status, motivo_cancelamento from tarefas");
    expect(tarefas.rows).toEqual([{ status: "cancelada", motivo_cancelamento: "atendimento_humano" }]);

    const ultima = t.recebidas(CONTATO).at(-1)!;
    expect(ultima).toContain("Registrei seu pedido para falar com a Janiere");
    expect(ultima).not.toMatch(/assumiu|sou a janiere/i);

    const antes = t.adaptador.enviados.length;
    const r = await t.enviar(CONTATO, "1");
    expect(r.status).toBe("pausada");
    expect(t.adaptador.enviados.length).toBe(antes);
    const avisos = await t.pool.query("select tipo from notificacoes_equipe order by criada_em, tipo");
    expect(avisos.rows.map((a) => a.tipo).sort()).toEqual(["atendimento_solicitado", "mensagem_em_atendimento"]);
  });

  it("assumir exige operador ativo; responder exige assumir antes", async () => {
    const conversaId = await pedirHumano();
    await expect(assumirAtendimento(t.deps, { conversaId, operadorId: ops.inativo })).rejects.toBeInstanceOf(ErroPermissao);
    await expect(responderComoOperador(t.deps, { conversaId, operadorId: ops.ana, texto: "Oi" })).rejects.toBeInstanceOf(ErroAtendimento);
  });

  it("só a pessoa responsável (ou admin) responde e devolve", async () => {
    const conversaId = await pedirHumano();
    await assumirAtendimento(t.deps, { conversaId, operadorId: ops.ana });

    await expect(assumirAtendimento(t.deps, { conversaId, operadorId: ops.bia })).rejects.toBeInstanceOf(ErroPermissao);
    await expect(responderComoOperador(t.deps, { conversaId, operadorId: ops.bia, texto: "Oi" })).rejects.toBeInstanceOf(ErroPermissao);
    await expect(devolverAoBot(t.deps, { conversaId, operadorId: ops.bia })).rejects.toBeInstanceOf(ErroPermissao);

    await responderComoOperador(t.deps, { conversaId, operadorId: ops.ana, texto: "Oi! Sou a Ana, da equipe da Janiere." });
    expect(t.recebidas(CONTATO).at(-1)).toBe("Oi! Sou a Ana, da equipe da Janiere.");
    const msg = await t.pool.query("select autor, operador_id from mensagens where direcao = 'saida' order by ordem desc limit 1");
    expect(msg.rows[0]).toEqual({ autor: "operador", operador_id: ops.ana });

    await devolverAoBot(t.deps, { conversaId, operadorId: ops.ana, resultado: "Dúvida resolvida" });
    const cv = await conversaDe(t.pool, CONTATO);
    expect(cv.controle).toBe("bot");
    const at = await t.pool.query("select status, devolvido_por, resultado from atendimentos");
    expect(at.rows[0]).toEqual({ status: "devolvido", devolvido_por: ops.ana, resultado: "Dúvida resolvida" });

    const r = await t.enviar(CONTATO, "bom dia");
    expect(r.status).toBe("processada");
    expect(t.recebidas(CONTATO).at(-1)).toContain("Como posso te ajudar?");
    expect(t.recebidas(CONTATO).at(-1)).not.toContain("assistente virtual");
  });

  it("admin pode transferir e devolver um atendimento de outra pessoa", async () => {
    const conversaId = await pedirHumano();
    await assumirAtendimento(t.deps, { conversaId, operadorId: ops.ana });
    await assumirAtendimento(t.deps, { conversaId, operadorId: ops.janiere });
    await devolverAoBot(t.deps, { conversaId, operadorId: ops.janiere });
    expect((await conversaDe(t.pool, CONTATO)).controle).toBe("bot");
  });

  it("devolver ao bot invalida seleções de menus antigos", async () => {
    await t.enviar(CONTATO, "oi");
    const menuAntigo = (await t.pool.query("select dados from mensagens where direcao = 'saida' order by ordem limit 1")).rows[0].dados
      .opcoes[0].id as string;
    await t.enviar(CONTATO, "HUMANO");
    const conversaId = (await conversaDe(t.pool, CONTATO)).id;
    await assumirAtendimento(t.deps, { conversaId, operadorId: ops.janiere });
    await devolverAoBot(t.deps, { conversaId, operadorId: ops.janiere });

    await t.acao(CONTATO, menuAntigo);
    expect(t.recebidas(CONTATO).at(-1)).toContain("Essa opção é de uma mensagem anterior");
    expect((await conversaDe(t.pool, CONTATO)).estado.modulo).toBeUndefined();
  });

  it("descadastro durante o atendimento é registrado sem resposta automática", async () => {
    await pedirHumano();
    const antes = t.adaptador.enviados.length;
    expect((await t.enviar(CONTATO, "SAIR")).status).toBe("pausada");
    expect(t.adaptador.enviados.length).toBe(antes);
    const cons = await t.pool.query("select finalidade, status from consentimentos order by finalidade");
    expect(cons.rows).toEqual([
      { finalidade: "acompanhamento", status: "revogado" },
      { finalidade: "marketing", status: "revogado" },
    ]);
    const avisos = await t.pool.query("select tipo from notificacoes_equipe where tipo = 'descadastro_em_atendimento'");
    expect(avisos.rowCount).toBe(1);
  });

  it("resposta humana fora da janela de 24h é bloqueada e auditada", async () => {
    const conversaId = await pedirHumano();
    await assumirAtendimento(t.deps, { conversaId, operadorId: ops.janiere });
    t.avancar(24 * 3_600_000 + 1);
    const antes = await t.pool.query("select count(*)::int as n from envios");

    const erro = await responderComoOperador(t.deps, { conversaId, operadorId: ops.janiere, texto: "Oi, tudo bem?" }).catch((e) => e);
    expect(erro).toBeInstanceOf(ErroEnvioBloqueado);
    expect(erro.codigo).toBe("fora_janela");
    expect((await t.pool.query("select count(*)::int as n from envios")).rows[0].n).toBe(antes.rows[0].n);
    const aud = await t.pool.query("select detalhes from auditoria where acao = 'envio_bloqueado'");
    expect(aud.rows[0].detalhes).toEqual({ codigo: "fora_janela" });
  });

  it("resposta humana com assunto não permitido no canal é bloqueada", async () => {
    const conversaId = await pedirHumano();
    await assumirAtendimento(t.deps, { conversaId, operadorId: ops.janiere });
    const erro = await responderComoOperador(t.deps, {
      conversaId,
      operadorId: ops.janiere,
      texto: "Que tal conhecer a oportunidade de ser distribuidora?",
    }).catch((e) => e);
    expect(erro).toBeInstanceOf(ErroEnvioBloqueado);
    expect(erro.codigo).toBe("tema_bloqueado");
  });
});
