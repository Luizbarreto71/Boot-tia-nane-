import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ErroEnvioDefinitivo, ErroEnvioIncerto } from "../../src/canais/tipos.js";
import { despacharPendentes } from "../../src/nucleo/envio.js";
import { receberMensagem } from "../../src/nucleo/recebimento.js";
import { limparBanco, montarTeste } from "../apoio/integracao.js";

let t: ReturnType<typeof montarTeste>;
const CONTATO = "5511977770001";

beforeEach(async () => {
  t = montarTeste();
  await limparBanco(t.pool);
});
afterEach(async () => {
  await t.encerrar();
});

const envios = async () =>
  (await t.pool.query("select status, tentativas, ultimo_erro from envios order by ordem")).rows as {
    status: string;
    tentativas: number;
    ultimo_erro: string | null;
  }[];

describe("outbox", () => {
  it("falha temporária é reagendada com recuo e para no limite de tentativas", async () => {
    t.adaptador.falharCom = new Error("HTTP 503");
    await t.enviar(CONTATO, "oi");
    expect(await envios()).toEqual([{ status: "pendente", tentativas: 1, ultimo_erro: "HTTP 503" }]);

    // Antes do recuo, nada é tentado.
    await despacharPendentes(t.deps);
    expect((await envios())[0]!.tentativas).toBe(1);

    t.avancar(31_000);
    await despacharPendentes(t.deps);
    expect((await envios())[0]).toMatchObject({ status: "pendente", tentativas: 2 });

    t.avancar(61_000);
    await despacharPendentes(t.deps);
    expect((await envios())[0]).toMatchObject({ status: "falhou", tentativas: 3 });
    expect(t.logs.join("\n")).toContain("falha no envio");
  });

  it("depois de uma falha, as mensagens seguintes da conversa esperam (ordem preservada)", async () => {
    await t.enviar(CONTATO, "oi");
    t.adaptador.falharCom = new Error("HTTP 500");
    await t.enviar(CONTATO, "1");
    await t.enviar(CONTATO, "sim");
    const lista = await envios();
    expect(lista.map((e) => e.status)).toEqual(["enviado", "pendente", "pendente"]);
    // A 3ª nem foi tentada: a 2ª ainda aguarda o recuo e não pode ser ultrapassada.
    expect(lista[2]!.tentativas).toBe(0);

    t.adaptador.falharCom = null;
    t.avancar(120_000);
    await despacharPendentes(t.deps);
    expect((await envios()).map((e) => e.status)).toEqual(["enviado", "enviado", "enviado"]);
    const textos = t.recebidas(CONTATO);
    expect(textos[1]).toContain("Nutricionista on-line");
    expect(textos[2]).toContain("Como posso te chamar?");
  });

  it("resultado incerto não é repetido automaticamente", async () => {
    t.adaptador.falharCom = new ErroEnvioIncerto("timeout após enviar a requisição");
    await t.enviar(CONTATO, "oi");
    t.adaptador.falharCom = null;
    t.avancar(3_600_000);
    await despacharPendentes(t.deps);
    expect(await envios()).toEqual([{ status: "incerto", tentativas: 1, ultimo_erro: "timeout após enviar a requisição" }]);
    expect(t.adaptador.enviados).toHaveLength(0);
  });

  it("recusa definitiva do provedor não é repetida", async () => {
    t.adaptador.falharCom = new ErroEnvioDefinitivo("HTTP 400 parâmetro inválido");
    await t.enviar(CONTATO, "oi");
    expect((await envios())[0]).toMatchObject({ status: "falhou", tentativas: 1 });
  });

  it("envio interrompido no meio (processo caiu) vira incerto na reconciliação", async () => {
    await t.enviar(CONTATO, "oi");
    await t.pool.query("update envios set status = 'enviando', atualizado_em = $1", [new Date(t.agora().getTime() - 10 * 60_000)]);
    await despacharPendentes(t.deps);
    expect((await envios())[0]!.status).toBe("incerto");
  });

  it("o despacho reavalia a política: mensagem que ficou para depois da janela é bloqueada", async () => {
    t.adaptador.falharCom = new Error("HTTP 503");
    await t.enviar(CONTATO, "oi");
    t.adaptador.falharCom = null;
    t.avancar(25 * 3_600_000);
    await despacharPendentes(t.deps);
    const [e] = await envios();
    expect(e!.status).toBe("bloqueado");
    expect(e!.ultimo_erro).toMatch(/^fora_janela/);
    expect(t.adaptador.enviados).toHaveLength(0);
  });

  it("o adaptador de simulação recusa mensagem não marcada como simulada", async () => {
    await expect(
      t.adaptador.enviar({ envioId: "x", canal: "whatsapp", destinatario: CONTATO, texto: "oi", opcoes: [], simulada: false, origem: "motor" }),
    ).rejects.toThrow(/simulação/);
  });

  it("o perfil de canal próprio só existe em simulação", async () => {
    await expect(
      receberMensagem(
        { ...t.deps, simulacao: false },
        { canal: "canal_proprio", contatoExterno: "x", idProvedor: "y", recebidaEm: t.agora(), conteudo: { tipo: "texto", texto: "oi" } },
      ),
    ).rejects.toThrow(/só existe em simulação/);
  });
});
