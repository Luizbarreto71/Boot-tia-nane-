import { describe, expect, it } from "vitest";
import { PERFIS } from "../../src/dominio/elegibilidade.js";
import { avaliarEnvio, JANELA_ATENDIMENTO_MS } from "../../src/nucleo/politica-envio.js";
import { negocioDemo } from "../apoio/negocio.js";

const negocio = negocioDemo();
const agora = new Date("2026-10-28T15:00:00Z");
const ha = (ms: number) => new Date(agora.getTime() - ms);
const dentro = { ultimaMensagemContatoEm: ha(60_000), consentimentoAcompanhamento: false };

describe("política de envio", () => {
  it("permite resposta dentro da janela de 24h", () => {
    expect(avaliarEnvio(PERFIS.whatsapp, negocio, dentro, { origem: "bot", modulo: "nutricao", texto: "Olá" }, agora)).toEqual({
      permitido: true,
    });
  });

  it.each(["bot", "operador", "tarefa"] as const)("bloqueia fora da janela, sem modelo aprovado (origem %s)", (origem) => {
    const situacao = { ultimaMensagemContatoEm: ha(JANELA_ATENDIMENTO_MS), consentimentoAcompanhamento: true };
    const d = avaliarEnvio(PERFIS.whatsapp, negocio, situacao, { origem, modulo: null, texto: "Oi" }, agora);
    expect(d).toMatchObject({ permitido: false, codigo: "fora_janela" });
  });

  it("bloqueia quando o contato nunca escreveu", () => {
    const d = avaliarEnvio(
      PERFIS.whatsapp,
      negocio,
      { ultimaMensagemContatoEm: null, consentimentoAcompanhamento: true },
      { origem: "operador", modulo: null, texto: "Oi" },
      agora,
    );
    expect(d).toMatchObject({ permitido: false, codigo: "fora_janela" });
  });

  it("bloqueia módulo e tema não elegíveis no canal, inclusive em texto humano", () => {
    expect(
      avaliarEnvio(PERFIS.whatsapp, negocio, dentro, { origem: "bot", modulo: "distribuidor", texto: "..." }, agora),
    ).toMatchObject({ permitido: false, codigo: "modulo_bloqueado" });
    for (const texto of ["Quer conhecer nossa oportunidade de negócio?", "Seja distribuidora!", "Te explico os royalties", "Temos um shake novo"]) {
      expect(avaliarEnvio(PERFIS.whatsapp, negocio, dentro, { origem: "operador", modulo: null, texto }, agora)).toMatchObject({
        permitido: false,
        codigo: "tema_bloqueado",
      });
    }
  });

  it("envio proativo exige consentimento vigente", () => {
    const d = avaliarEnvio(PERFIS.whatsapp, negocio, dentro, { origem: "tarefa", modulo: "nutricao", texto: "Lembrete" }, agora);
    expect(d).toMatchObject({ permitido: false, codigo: "sem_consentimento" });
  });

  it("o perfil hipotético de canal próprio não aplica janela nem bloqueio de tema", () => {
    const d = avaliarEnvio(
      PERFIS.canal_proprio,
      negocio,
      { ultimaMensagemContatoEm: null, consentimentoAcompanhamento: false },
      { origem: "bot", modulo: "distribuidor", texto: "renda extra" },
      agora,
    );
    expect(d).toEqual({ permitido: true });
  });
});
