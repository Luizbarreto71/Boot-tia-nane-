import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ErroEnvioDefinitivo, ErroEnvioIncerto, type EnvioSaida } from "../../src/canais/tipos.js";
import { AdaptadorWhatsApp, assinaturaValida, corpoDoEnvio, extrairEventos } from "../../src/canais/whatsapp.js";

const SEGREDO = "segredo-do-app-teste";
const assinar = (corpo: string, segredo = SEGREDO) => `sha256=${createHmac("sha256", segredo).update(corpo).digest("hex")}`;

describe("assinatura do webhook", () => {
  const corpo = '{"object":"whatsapp_business_account"}';
  it("aceita só HMAC-SHA256 do corpo bruto com o segredo do app", () => {
    expect(assinaturaValida(Buffer.from(corpo), assinar(corpo), SEGREDO)).toBe(true);
    expect(assinaturaValida(Buffer.from(`${corpo} `), assinar(corpo), SEGREDO)).toBe(false);
    expect(assinaturaValida(Buffer.from(corpo), assinar(corpo, "outro-segredo"), SEGREDO)).toBe(false);
    expect(assinaturaValida(Buffer.from(corpo), undefined, SEGREDO)).toBe(false);
    expect(assinaturaValida(Buffer.from(corpo), assinar(corpo).replace("sha256=", ""), SEGREDO)).toBe(false);
    expect(assinaturaValida(Buffer.from(corpo), "sha256=abc", SEGREDO)).toBe(false);
  });
});

const NUMERO = "1029384756";
const payload = (valor: Record<string, unknown>, numero = NUMERO, campo = "messages") => ({
  object: "whatsapp_business_account",
  entry: [{ id: "WABA", changes: [{ field: campo, value: { messaging_product: "whatsapp", metadata: { phone_number_id: numero }, ...valor } }] }],
});

describe("leitura do webhook", () => {
  it("lê texto, seleções de lista e botões, mídia e nome do perfil", () => {
    const r = extrairEventos(
      payload({
        contacts: [{ wa_id: "5511900000001", profile: { name: "Ana" } }],
        messages: [
          { from: "5511900000001", id: "wamid.1", timestamp: "1793210400", type: "text", text: { body: "Oi" } },
          { from: "5511900000001", id: "wamid.2", timestamp: "1793210401", type: "interactive", interactive: { type: "list_reply", list_reply: { id: "p3:1", title: "Nutricionista on-line" } } },
          { from: "5511900000001", id: "wamid.3", timestamp: "1793210402", type: "interactive", interactive: { type: "button_reply", button_reply: { id: "p4:2", title: "Voltar ao menu" } } },
          { from: "5511900000001", id: "wamid.4", timestamp: "1793210403", type: "audio", audio: { id: "x" } },
        ],
      }),
      NUMERO,
    );
    expect(r.mensagens.map((m) => m.conteudo)).toEqual([
      { tipo: "texto", texto: "Oi" },
      { tipo: "acao", id: "p3:1", titulo: "Nutricionista on-line" },
      { tipo: "acao", id: "p4:2", titulo: "Voltar ao menu" },
      { tipo: "midia", descricao: "audio" },
    ]);
    expect(r.mensagens[0]).toMatchObject({ canal: "whatsapp", contatoExterno: "5511900000001", nomePerfil: "Ana", idProvedor: "wamid.1" });
    expect(r.mensagens[0]!.recebidaEm.toISOString()).toBe("2026-10-28T18:00:00.000Z");
  });

  it("status de entrega é separado das mensagens e não vira conversa", () => {
    const r = extrairEventos(
      payload({ statuses: [{ id: "wamid.saida", status: "failed", timestamp: "1793210400", errors: [{ code: 131047, title: "Re-engagement message" }] }] }),
      NUMERO,
    );
    expect(r.mensagens).toEqual([]);
    expect(r.status).toEqual([{ idProvedor: "wamid.saida", status: "failed", em: new Date(1793210400 * 1000), erro: "131047 Re-engagement message" }]);
  });

  it("descarta outro número, outro campo e objeto desconhecido", () => {
    const msg = { messages: [{ from: "1", id: "wamid.x", type: "text", text: { body: "oi" } }] };
    expect(extrairEventos(payload(msg, "999"), NUMERO)).toMatchObject({ mensagens: [], ignorados: [{ motivo: "numero_desconhecido" }] });
    expect(extrairEventos(payload(msg, NUMERO, "account_update"), NUMERO).ignorados[0]!.motivo).toBe("campo_ignorado");
    expect(extrairEventos({ object: "page" }, NUMERO).ignorados[0]!.motivo).toBe("objeto_desconhecido");
  });
});

const opcoes = (...rotulos: string[]) => rotulos.map((rotulo, i) => ({ id: `p1:${i + 1}`, numero: i + 1, rotulo }));

describe("formato de envio", () => {
  it("sem opções: texto sem pré-visualização de link", () => {
    expect(corpoDoEnvio({ destinatario: "55", texto: "Olá", opcoes: [] })).toMatchObject({ type: "text", text: { body: "Olá", preview_url: false } });
  });

  it("até 3 opções curtas: botões; rótulo longo: lista com título truncado e descrição completa", () => {
    expect(corpoDoEnvio({ destinatario: "55", texto: "?", opcoes: opcoes("Sim, quero solicitar", "Voltar ao menu") })).toMatchObject({
      interactive: { type: "button", action: { buttons: [{ reply: { id: "p1:1", title: "Sim, quero solicitar" } }, {}] } },
    });
    const menu = corpoDoEnvio({ destinatario: "55", texto: "Menu", opcoes: opcoes("Nutricionista on-line", "Personal Trainer on-line", "Falar diretamente com Janiere") }) as any;
    expect(menu.interactive.type).toBe("list");
    const linhas = menu.interactive.action.sections[0].rows;
    expect(linhas[2]).toEqual({ id: "p1:3", title: "Falar diretamente com J…", description: "Falar diretamente com Janiere" });
    expect(linhas.every((l: { title: string }) => l.title.length <= 24)).toBe(true);
  });

  it("mais de 10 opções: texto numerado", () => {
    const corpo = corpoDoEnvio({ destinatario: "55", texto: "Escolha", opcoes: opcoes(...Array.from({ length: 11 }, (_, i) => `Op ${i}`)) }) as any;
    expect(corpo.type).toBe("text");
    expect(corpo.text.body).toContain("11. Op 10");
  });
});

describe("adaptador WhatsApp", () => {
  const envio: EnvioSaida = { envioId: "e1", canal: "whatsapp", destinatario: "5511900000001", texto: "Oi", opcoes: [], simulada: false, origem: "motor" };
  const TOKEN = "EAAG-token-secreto";
  const adaptador = (resposta: () => Promise<Response>, chamadas: { url: string; init: RequestInit }[] = []) =>
    new AdaptadorWhatsApp({ tokenAcesso: TOKEN, idNumero: NUMERO, versaoGraph: "v26.0" }, (async (url: string, init: RequestInit) => {
      chamadas.push({ url, init });
      return resposta();
    }) as typeof fetch);
  const json = (status: number, corpo: unknown) => async () => new Response(JSON.stringify(corpo), { status });

  it("envia para a versão e o número configurados e devolve o id da mensagem", async () => {
    const chamadas: { url: string; init: RequestInit }[] = [];
    const r = await adaptador(json(200, { messages: [{ id: "wamid.ok" }] }), chamadas).enviar(envio);
    expect(r).toEqual({ idProvedor: "wamid.ok" });
    expect(chamadas[0]!.url).toBe(`https://graph.facebook.com/v26.0/${NUMERO}/messages`);
    expect((chamadas[0]!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("classifica falhas: 4xx definitiva, 429/5xx repetível, timeout incerto — sem expor o token", async () => {
    const e400 = await adaptador(json(400, { error: { code: 131047, message: "Re-engagement message" } })).enviar(envio).catch((e) => e);
    expect(e400).toBeInstanceOf(ErroEnvioDefinitivo);
    expect(e400.message).toContain("131047");
    expect(e400.message).not.toContain(TOKEN);

    for (const status of [429, 500, 503]) {
      const e = await adaptador(json(status, { error: { message: "tente depois" } })).enviar(envio).catch((x) => x);
      expect(e).toBeInstanceOf(Error);
      expect(e).not.toBeInstanceOf(ErroEnvioDefinitivo);
      expect(e).not.toBeInstanceOf(ErroEnvioIncerto);
    }

    const timeout = await adaptador(async () => {
      throw new DOMException("tempo esgotado", "TimeoutError");
    }).enviar(envio).catch((e) => e);
    expect(timeout).toBeInstanceOf(ErroEnvioIncerto);

    const semRede = await adaptador(async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    }).enviar(envio).catch((e) => e);
    expect(semRede).not.toBeInstanceOf(ErroEnvioIncerto);
  });

  it("recusa mensagem marcada como simulada", async () => {
    await expect(adaptador(json(200, {})).enviar({ ...envio, simulada: true })).rejects.toBeInstanceOf(ErroEnvioDefinitivo);
  });
});
