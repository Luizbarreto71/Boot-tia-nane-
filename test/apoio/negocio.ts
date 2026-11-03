import { readFileSync } from "node:fs";
import { validarNegocio, type ConfigNegocio } from "../../src/config/negocio.js";

type Bruto = Record<string, any>;

const lerDemo = (): Bruto => JSON.parse(readFileSync("config/negocio.demo.json", "utf8"));

export function negocioDemo(ajustar?: (bruto: Bruto) => void): ConfigNegocio {
  const bruto = lerDemo();
  ajustar?.(bruto);
  return validarNegocio(bruto, { simulacao: true });
}

/** Configuração "de produção" para testes: não demonstrativa, com preço aprovado só na nutrição. */
export function negocioAprovado(ajustar?: (bruto: Bruto) => void): ConfigNegocio {
  const bruto = lerDemo();
  bruto.demonstrativo = false;
  bruto.servicos.nutricao.preco = { valorCentavos: 15000 };
  bruto.servicos.nutricao.revisao = { aprovadoPor: "Janiere Gomes", data: "2026-10-28", fonte: "teste" };
  // Preço preenchido mas sem revisão: não pode aparecer.
  bruto.servicos.personal.preco = { valorCentavos: 9900 };
  bruto.servicos.personal.revisao = null;
  ajustar?.(bruto);
  return validarNegocio(bruto, { simulacao: false });
}
