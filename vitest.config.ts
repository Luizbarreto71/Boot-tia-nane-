import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Os testes de integração compartilham um banco; arquivos rodam em série.
    fileParallelism: false,
    projects: [
      {
        test: {
          name: "unidade",
          include: ["test/unidade/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "integracao",
          include: ["test/integracao/**/*.test.ts"],
          globalSetup: ["test/integracao/preparar-banco.ts"],
          testTimeout: 20_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
