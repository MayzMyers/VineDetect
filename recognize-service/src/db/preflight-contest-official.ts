import { writeFile } from "node:fs/promises";
import { officialPreflight } from "../modules/contest-official/contest-official.service.js";
import { pool } from "./pool.js";
try {
  const result = await officialPreflight();
  const output = process.argv[2];
  if (output) await writeFile(output, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ ...result, targets: undefined }));
} finally {
  await pool.end();
}
