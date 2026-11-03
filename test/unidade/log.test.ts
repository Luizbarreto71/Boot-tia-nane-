import { describe, expect, it } from "vitest";
import { criarLogger, MASCARA } from "../../src/lib/log.js";

describe("log", () => {
  it("não grava credenciais: chaves sensíveis e valores de segredo são mascarados", () => {
    const linhas: string[] = [];
    const log = criarLogger({ segredos: ["EAAG-token-real-123", "sk-ant-chave-456"], escrever: (l) => linhas.push(l) });
    log.error("falha ao chamar a API com EAAG-token-real-123", {
      accessToken: "qualquer-coisa",
      headers: { Authorization: "Bearer xyz" },
      DATABASE_URL: "postgres://u:p@h/db",
      erro: new Error("resposta inválida para sk-ant-chave-456"),
      contato: "sim-1",
    });
    const saida = linhas.join("\n");
    for (const vazamento of ["EAAG-token-real-123", "sk-ant-chave-456", "qualquer-coisa", "Bearer xyz", "u:p@h"]) {
      expect(saida).not.toContain(vazamento);
    }
    expect(saida).toContain(MASCARA);
    expect(saida).toContain("sim-1");
  });

  it("respeita o nível mínimo", () => {
    const linhas: string[] = [];
    const log = criarLogger({ nivel: "warn", escrever: (l) => linhas.push(l) });
    log.info("detalhe");
    log.warn("atenção");
    expect(linhas).toHaveLength(1);
  });
});
