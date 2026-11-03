import Fastify, { type FastifyInstance } from "fastify";
import { assinaturaValida, tokenVerificacaoConfere, type ConfigWhatsApp } from "./canais/whatsapp.js";
import type { Dependencias } from "./nucleo/dependencias.js";
import { gravarEvento } from "./nucleo/eventos.js";

/**
 * Webhook da WhatsApp Cloud API.
 *   GET  /webhook/whatsapp  verificação (hub.mode=subscribe + token de verificação)
 *   POST /webhook/whatsapp  assinatura HMAC-SHA256 sobre o corpo bruto → grava o evento → 200
 * O processamento (IA, respostas) acontece fora da requisição. Se a gravação falhar, responde 500
 * e a Meta reenvia: nada é confirmado sem estar gravado.
 */
export function criarServidor(
  deps: Dependencias,
  wa: Pick<ConfigWhatsApp, "segredoApp" | "tokenVerificacao">,
  aoGravar: () => void = () => undefined,
): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 3 * 1024 * 1024 });
  // O corpo chega cru (Buffer): a assinatura é calculada sobre os bytes exatos recebidos.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_req, corpo, done) => done(null, corpo));

  app.get("/saude", async () => ({ ok: true }));

  app.get("/webhook/whatsapp", async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    if (q["hub.mode"] === "subscribe" && tokenVerificacaoConfere(q["hub.verify_token"], wa.tokenVerificacao)) {
      return reply.type("text/plain").send(String(q["hub.challenge"] ?? ""));
    }
    deps.log.warn("verificação do webhook recusada");
    return reply.code(403).send();
  });

  app.post("/webhook/whatsapp", async (req, reply) => {
    const corpo = req.body;
    if (!Buffer.isBuffer(corpo) || !assinaturaValida(corpo, req.headers["x-hub-signature-256"], wa.segredoApp)) {
      deps.log.warn("webhook com assinatura inválida recusado", { ip: req.ip });
      return reply.code(401).send();
    }
    let json: unknown;
    try {
      json = JSON.parse(corpo.toString("utf8"));
    } catch {
      return reply.code(400).send();
    }
    try {
      await gravarEvento(deps, json);
    } catch (e) {
      deps.log.error("não foi possível gravar o evento do webhook", { erro: e });
      return reply.code(500).send();
    }
    aoGravar();
    return reply.code(200).send();
  });

  return app;
}
