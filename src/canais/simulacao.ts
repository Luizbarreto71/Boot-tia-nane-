import { randomUUID } from "node:crypto";
import type { CanalId } from "../dominio/elegibilidade.js";
import type { AdaptadorCanal, EnvioSaida } from "./tipos.js";

/** Adaptador de simulação: nada sai da máquina. Guarda os envios e avisa um observador (CLI, testes). */
export class AdaptadorSimulacao implements AdaptadorCanal {
  readonly enviados: (EnvioSaida & { idProvedor: string })[] = [];
  /** Permite simular falhas do provedor nos testes. */
  falharCom: Error | null = null;

  constructor(
    readonly canal: CanalId,
    private readonly aoEnviar?: (envio: EnvioSaida) => void,
  ) {}

  async enviar(envio: EnvioSaida): Promise<{ idProvedor: string }> {
    if (this.falharCom) throw this.falharCom;
    if (!envio.simulada) throw new Error("O adaptador de simulação só aceita mensagens marcadas como simuladas.");
    const idProvedor = `sim-saida-${randomUUID()}`;
    this.enviados.push({ ...envio, idProvedor });
    this.aoEnviar?.(envio);
    return { idProvedor };
  }
}
