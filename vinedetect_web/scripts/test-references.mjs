// Compile selected TypeScript tests for the Node 20 runtime used by Docker.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = mkdtempSync(join(tmpdir(), "vinedetect-references-test-"));
const tests = process.argv.length > 2 ? process.argv.slice(2) : [
  "lib/recognition/references.test.ts",
  "app/api/recognition/references/route.test.ts",
];

try {
  const config = join(output, "tsconfig.json");
  writeFileSync(config, JSON.stringify({
    compilerOptions: {
      outDir: output, rootDir: root, module: "commonjs", moduleResolution: "node",
      target: "ES2022", esModuleInterop: true, skipLibCheck: true,
      rewriteRelativeImportExtensions: true, jsx: "react-jsx", resolveJsonModule: true,
      paths: { "@/*": [join(root, "*")] },
      typeRoots: [join(root, "node_modules/@types")],
    },
    files: tests.map((test) => join(root, test)),
  }));
  const compile = spawnSync(process.execPath, [
    fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url)),
    "--project", config,
  ], { cwd: root, stdio: "inherit" });
  if (compile.error) throw compile.error;
  if (compile.status !== 0) process.exitCode = compile.status ?? 1;
  else {
    const run = spawnSync(process.execPath, [
      "--test", ...tests.map((test) => join(output, test.replace(/\.ts$/, ".js"))),
    ], { cwd: root, stdio: "inherit" });
    if (run.error) throw run.error;
    process.exitCode = run.status ?? 1;
  }
} finally {
  rmSync(output, { recursive: true, force: true });
}
