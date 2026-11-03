import { describe, expect, it } from "vitest";
import { detectarComando } from "../../src/conversa/comandos.js";
import { normalizar } from "../../src/lib/texto.js";

const cmd = (t: string) => detectarComando(normalizar(t))?.tipo ?? null;

describe("comandos globais", () => {
  it.each(["SAIR", "Parar", "pare", "STOP", "pare de me mandar mensagem", "não quero mais receber mensagens", "me descadastra", "me tira da lista"])(
    "reconhece descadastro claro: %s",
    (t) => expect(cmd(t)).toBe("descadastro"),
  );

  it.each([
    ["não consigo parar de comer doce", null],
    ["parar de fumar ajuda a emagrecer?", null],
    ["quero sair da dieta", null],
    ["quero cancelar o agendamento", "cancelar_solicitacao"],
    ["preciso desmarcar minha consulta", "cancelar_solicitacao"],
    ["cancelar", "cancelar_fluxo"],
  ])("não confunde com descadastro: %s", (t, esperado) => expect(cmd(t)).toBe(esperado));

  it.each([
    ["MENU", "menu"],
    ["INÍCIO", "menu"],
    ["inicio", "menu"],
    ["VOLTAR", "voltar"],
    ["HUMANO", "humano"],
    ["JANIERE", "humano"],
    ["quero falar com a Janiere", "humano"],
    ["posso falar com uma pessoa?", "humano"],
  ])("%s → %s", (t, esperado) => expect(cmd(t)).toBe(esperado));
});
