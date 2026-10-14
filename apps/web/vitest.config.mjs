import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));

export default {
  root,
  test: {
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
  },
};
