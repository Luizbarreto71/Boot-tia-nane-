import { describe, expect, it } from "vitest";
import { carregarAmbiente } from "../../src/config/env.js";
import { validarNegocio } from "../../src/config/negocio.js";
import { foraDoExpediente } from "../../src/conversa/textos.js";
import { PERFIS, modulosVisiveis } from "../../src/dominio/elegibilidade.js";
import { negocioDemo } from "../apoio/negocio.js";
import { readFileSync } from "node:fs";

const base = { DATABASE_URL: "postgres://u:senha-muito-secreta@localhost:1/x" };

describe("ambiente", () => {
  it("padrões seguros: simulação ligada, acompanhamentos desligados, fuso de São Paulo", () => {
    const env = carregarAmbiente({ ...base });
    expect(env).toMatchObject({ SIMULATION_MODE: true, FOLLOWUPS_ENABLED: false, TIMEZONE: "America/Sao_Paulo" });
  });

  it("fora da simulação exige as variáveis do WhatsApp e não ecoa valores no erro", () => {
    const tentar = () => carregarAmbiente({ ...base, SIMULATION_MODE: "false", WHATSAPP_ACCESS_TOKEN: "EAAG-valor-secreto" });
    expect(tentar).toThrow(/META_APP_SECRET: obrigatória/);
    try {
      tentar();
    } catch (e) {
      expect((e as Error).message).not.toContain("EAAG-valor-secreto");
      expect((e as Error).message).not.toContain("senha-muito-secreta");
    }
  });

  it("recusa ligar acompanhamentos antes da etapa 4", () => {
    expect(() => carregarAmbiente({ ...base, FOLLOWUPS_ENABLED: "true" })).toThrow(/FOLLOWUPS_ENABLED/);
  });

  it("valores booleanos precisam ser explícitos", () => {
    expect(() => carregarAmbiente({ ...base, SIMULATION_MODE: "sim" })).toThrow(/SIMULATION_MODE/);
  });
});

describe("configuração do negócio", () => {
  const demo = () => JSON.parse(readFileSync("config/negocio.demo.json", "utf8"));

  it("configuração demonstrativa é recusada fora da simulação", () => {
    expect(() => validarNegocio(demo(), { simulacao: false })).toThrow(/demonstrativa/);
  });

  it("não existe forma de habilitar por configuração um módulo bloqueado no canal", () => {
    const bruto = demo();
    bruto.modulosHabilitados = ["distribuidor"]; // campo inexistente: ignorado pelo esquema
    const n = validarNegocio(bruto, { simulacao: true });
    expect(modulosVisiveis(PERFIS.whatsapp, n)).toEqual(["nutricao", "personal", "falar_janiere"]);
  });

  it("rejeita rótulos longos demais para botões e listas", () => {
    const bruto = demo();
    bruto.periodos[0].rotulo = "Um rótulo comprido demais para botão";
    expect(() => validarNegocio(bruto, { simulacao: true })).toThrow(/periodos/);
  });

  it("expediente é avaliado no fuso de São Paulo", () => {
    const n = negocioDemo();
    expect(foraDoExpediente(n, new Date("2026-10-28T11:30:00Z"))).toBe(false); // qua 08:30
    expect(foraDoExpediente(n, new Date("2026-10-28T10:59:00Z"))).toBe(true); // qua 07:59
    expect(foraDoExpediente(n, new Date("2026-10-28T21:00:00Z"))).toBe(true); // qua 18:00
    expect(foraDoExpediente(n, new Date("2026-10-31T15:00:00Z"))).toBe(true); // sábado
  });
});
