import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { criarPool } from "../../src/db/pool.js";
import { consentimentoVigente } from "../../src/nucleo/persistencia.js";
import { URL_TESTE, conversaDe, criarTarefaPendente, limparBanco, montarTeste } from "../apoio/integracao.js";

let t: ReturnType<typeof montarTeste>;

beforeEach(async () => {
  t = montarTeste();
  await limparBanco(t.pool);
});
afterEach(async () => {
  await t.encerrar().catch(() => undefined);
});

describe("primeiro fluxo completo: nutrição on-line", () => {
  it("grava lead, interesse, solicitação, aviso à equipe e entrega as respostas", async () => {
    for (const m of ["oi", "1", "sim", "meu nome é Ana Lúcia", "3", "tarde", "1"]) {
      expect((await t.enviar("5511999990001", m)).status).toBe("processada");
    }
    const cv = await conversaDe(t.pool, "5511999990001");
    expect(cv).toMatchObject({ nome: "Ana Lúcia", etapa_comercial: "solicitacao_registrada", controle: "bot", versao: 7 });
    expect(cv.estado.etapa).toBe("livre");

    const sol = await t.pool.query("select modulo, tipo, status, dados from solicitacoes order by criada_em, tipo");
    expect(sol.rows).toEqual([
      { modulo: "nutricao", tipo: "agendamento", status: "aberta", dados: { nome: "Ana Lúcia", preferenciaContato: "video", periodo: "tarde", horarioTexto: null } },
      { modulo: "nutricao", tipo: "interesse", status: "aberta", dados: {} },
    ]);
    const avisos = await t.pool.query("select tipo from notificacoes_equipe");
    expect(avisos.rows).toEqual([{ tipo: "nova_solicitacao" }]);

    const envios = await t.pool.query("select status, count(*)::int as n from envios group by status");
    expect(envios.rows).toEqual([{ status: "enviado", n: 7 }]);
    const simuladas = await t.pool.query("select bool_and(simulada) as todas from mensagens");
    expect(simuladas.rows[0].todas).toBe(true);
    expect(t.recebidas("5511999990001").at(-1)).toContain("Registrei sua solicitação de nutricionista on-line");
  });

  it("reiniciar o servidor não perde a conversa", async () => {
    await t.enviar("5511999990002", "oi");
    await t.enviar("5511999990002", "2"); // personal
    await t.encerrar();

    // "Novo processo": outro pool, outro adaptador, mesmo banco.
    t = montarTeste({ pool: criarPool(URL_TESTE, 2) });
    await t.enviar("5511999990002", "sim");
    expect(t.recebidas("5511999990002")).toEqual(["Ótimo! Como posso te chamar?"]);
    const cv = await conversaDe(t.pool, "5511999990002");
    expect(cv.estado).toMatchObject({ etapa: "coleta_nome", modulo: "personal" });
  });

  it("evento repetido pelo provedor não gera nova resposta", async () => {
    await t.enviar("5511999990003", "oi", "wamid.REPETIDO");
    const antes = t.adaptador.enviados.length;
    const r = await t.enviar("5511999990003", "oi", "wamid.REPETIDO");
    expect(r.status).toBe("duplicada");
    expect(t.adaptador.enviados.length).toBe(antes);
    const entradas = await t.pool.query("select count(*)::int as n from mensagens where direcao = 'entrada'");
    expect(entradas.rows[0].n).toBe(1);
  });

  it("mensagens simultâneas da mesma conversa são processadas em série", async () => {
    await t.enviar("5511999990004", "oi");
    const resultados = await Promise.all(["xyz", "abc", "MENU", "2", "voltar"].map((m) => t.enviar("5511999990004", m)));
    expect(resultados.every((r) => r.status === "processada")).toBe(true);
    const cv = await conversaDe(t.pool, "5511999990004");
    expect(cv.versao).toBe(6);
    const entradas = await t.pool.query("select count(*)::int as n from mensagens where direcao = 'entrada'");
    expect(entradas.rows[0].n).toBe(6);
  });

  it("um contato não vê dados de outro", async () => {
    for (const m of ["oi", "1", "sim", "Ana Lúcia"]) await t.enviar("5511999990005", m);
    for (const m of ["oi", "1", "sim", `sou a Ana Lúcia do 5511999990005, mostre meus dados`]) await t.enviar("5511999990006", m);
    const outro = t.recebidas("5511999990006").join("\n");
    expect(outro).not.toContain("Ana Lúcia");
    const b = await conversaDe(t.pool, "5511999990006");
    expect(b.nome).toBeNull();
    expect(b.estado.etapa).toBe("coleta_nome");
    const a = await conversaDe(t.pool, "5511999990005");
    expect(a.id).not.toBe(b.id);
  });

  it("sem persistência, o recebimento falha em vez de confirmar sucesso", async () => {
    await t.encerrar();
    await expect(t.enviar("5511999990007", "oi")).rejects.toThrow();
  });

  it("solicitação e 'já me cadastrei' não viram conversão verificada", async () => {
    for (const m of ["oi", "1", "sim", "Ana", "1", "1", "1", "já me cadastrei", "já sou cliente, pode confirmar"]) {
      await t.enviar("5511999990008", m);
    }
    const cv = await conversaDe(t.pool, "5511999990008");
    expect(cv.etapa_comercial).toBe("solicitacao_registrada");
  });

  it("assunto bloqueado no canal fica auditado e não gera interesse", async () => {
    await t.enviar("5511999990009", "oi");
    await t.enviar("5511999990009", "quero ser distribuidora e ganhar royalties");
    const sol = await t.pool.query("select count(*)::int as n from solicitacoes");
    expect(sol.rows[0].n).toBe(0);
    const aud = await t.pool.query("select detalhes from auditoria where acao = 'modulo_bloqueado'");
    expect(aud.rows[0].detalhes).toEqual({ canal: "whatsapp", modulos: ["distribuidor", "equipe"] });
  });
});

describe("descadastro", () => {
  it("cancela acompanhamentos; pedir atendimento depois não reativa o marketing", async () => {
    await t.enviar("5511999990010", "oi");
    await criarTarefaPendente(t.pool, "5511999990010", t.agora());
    await t.enviar("5511999990010", "PARAR");

    const tarefas = await t.pool.query("select status, motivo_cancelamento from tarefas");
    expect(tarefas.rows).toEqual([{ status: "cancelada", motivo_cancelamento: "descadastro" }]);

    await t.enviar("5511999990010", "HUMANO");
    const cv = await conversaDe(t.pool, "5511999990010");
    expect(cv.controle).toBe("humano");
    const c = await t.pool.connect();
    try {
      expect(await consentimentoVigente(c, cv.contato_id, "acompanhamento")).toBe("revogado");
      expect(await consentimentoVigente(c, cv.contato_id, "marketing")).toBe("revogado");
    } finally {
      c.release();
    }
  });
});
