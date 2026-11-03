import { createHmac } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { processarEventosPendentes } from "../../src/nucleo/eventos.js";
import { criarServidor } from "../../src/servidor.js";
import { conversaDe, limparBanco, montarTeste } from "../apoio/integracao.js";

const SEGREDO = "segredo-app-integracao";
const TOKEN_VERIFICACAO = "token-verificacao-123";
const NUMERO = "1029384756";
const C = "5511955550001";

let t: ReturnType<typeof montarTeste>;
let servidor: FastifyInstance;

beforeEach(async () => {
  t = montarTeste();
  await limparBanco(t.pool);
  servidor = criarServidor(t.deps, { segredoApp: SEGREDO, tokenVerificacao: TOKEN_VERIFICACAO });
});
afterEach(async () => {
  await servidor.close();
  await t.encerrar().catch(() => undefined);
});

const assinar = (corpo: string) => `sha256=${createHmac("sha256", SEGREDO).update(corpo).digest("hex")}`;
const ts = () => String(Math.floor(t.agora().getTime() / 1000));

function evento(valor: Record<string, unknown>, numero = NUMERO) {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{ id: "WABA", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: numero }, ...valor } }] }],
  });
}
const texto = (id: string, body: string, numero = NUMERO) =>
  evento({ contacts: [{ wa_id: C, profile: { name: "Ana" } }], messages: [{ from: C, id, timestamp: ts(), type: "text", text: { body } }] }, numero);

/** assinatura null = cabeçalho ausente. */
const postar = (corpo: string, assinatura: string | null = assinar(corpo)) =>
  servidor.inject({
    method: "POST",
    url: "/webhook/whatsapp",
    payload: corpo,
    headers: { "content-type": "application/json", ...(assinatura !== null ? { "x-hub-signature-256": assinatura } : {}) },
  });
const eventosGravados = async () => (await t.pool.query("select count(*)::int as n from eventos_recebidos")).rows[0].n as number;

describe("webhook do WhatsApp", () => {
  it("verificação GET devolve o desafio só com o token certo", async () => {
    const ok = await servidor.inject({ method: "GET", url: `/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=${TOKEN_VERIFICACAO}&hub.challenge=42` });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe("42");
    const errado = await servidor.inject({ method: "GET", url: "/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=outro&hub.challenge=42" });
    expect(errado.statusCode).toBe(403);
  });

  it("assinatura inválida ou ausente é recusada e nada é gravado", async () => {
    const corpo = texto("wamid.a", "oi");
    expect((await postar(corpo, assinar(`${corpo}x`))).statusCode).toBe(401);
    expect((await postar(corpo, null)).statusCode).toBe(401);
    expect(await eventosGravados()).toBe(0);
  });

  it("evento válido é gravado antes do 200 e respondido pelo processamento", async () => {
    const r = await postar(texto("wamid.b", "oi"));
    expect(r.statusCode).toBe(200);
    expect(await eventosGravados()).toBe(1);
    expect(t.recebidas(C)).toEqual([]); // nada é processado dentro da requisição

    expect(await processarEventosPendentes(t.deps, NUMERO)).toBe(1);
    expect(t.recebidas(C)[0]).toContain("assistente virtual da Janiere Gomes");
    expect((await conversaDe(t.pool, C)).nome_perfil).toBe("Ana");
    const ev = await t.pool.query("select status from eventos_recebidos");
    expect(ev.rows).toEqual([{ status: "processado" }]);
  });

  it("entrega repetida do mesmo evento gera uma única resposta", async () => {
    const corpo = texto("wamid.c", "oi");
    await postar(corpo);
    await postar(corpo);
    await processarEventosPendentes(t.deps, NUMERO);
    expect(t.recebidas(C)).toHaveLength(1);
  });

  it("status de entrega atualiza o envio e não aciona o bot", async () => {
    await postar(texto("wamid.d", "oi"));
    await processarEventosPendentes(t.deps, NUMERO);
    const { id_provedor } = (await t.pool.query("select id_provedor from envios")).rows[0];
    const antes = t.adaptador.enviados.length;

    await postar(evento({ statuses: [{ id: id_provedor, status: "read", timestamp: ts(), recipient_id: C }] }));
    await processarEventosPendentes(t.deps, NUMERO);
    expect(t.adaptador.enviados.length).toBe(antes);
    expect((await t.pool.query("select status_provedor from envios")).rows).toEqual([{ status_provedor: "read" }]);
    expect((await t.pool.query("select count(*)::int as n from mensagens where direcao = 'entrada'")).rows[0].n).toBe(1);
  });

  it("evento de outro número é descartado e auditado", async () => {
    await postar(texto("wamid.e", "oi", "999999"));
    await processarEventosPendentes(t.deps, NUMERO);
    expect(await conversaDe(t.pool, C)).toBeUndefined();
    const aud = await t.pool.query("select detalhes from auditoria where acao = 'evento_ignorado'");
    expect(aud.rows[0].detalhes).toEqual({ motivo: "numero_desconhecido", detalhe: "999999" });
  });

  it("seleção de lista interativa segue o estado; áudio recebe aviso de que só texto é lido", async () => {
    await postar(texto("wamid.f", "oi"));
    await processarEventosPendentes(t.deps, NUMERO);
    const acao = (await t.pool.query("select dados from mensagens where direcao = 'saida' order by ordem limit 1")).rows[0].dados.opcoes[1].id;
    await postar(
      evento({ messages: [{ from: C, id: "wamid.g", timestamp: ts(), type: "interactive", interactive: { type: "list_reply", list_reply: { id: acao, title: "Personal Trainer on-line" } } }] }),
    );
    await postar(evento({ messages: [{ from: C, id: "wamid.h", timestamp: ts(), type: "audio", audio: { id: "midia1" } }] }));
    await processarEventosPendentes(t.deps, NUMERO);
    const recebidas = t.recebidas(C);
    expect(recebidas[1]).toContain("*Personal Trainer on-line*");
    expect(recebidas[2]).toContain("consigo ler apenas mensagens de texto");
  });

  it("JSON inválido com assinatura válida é recusado", async () => {
    expect((await postar("{nao é json")).statusCode).toBe(400);
  });

  it("sem banco, o webhook responde 500 (a Meta reenvia) em vez de confirmar", async () => {
    await t.encerrar();
    expect((await postar(texto("wamid.i", "oi"))).statusCode).toBe(500);
  });
});
