#!/usr/bin/env node
/*
 * 로컬 개발: API + 정적 파일을 한 서버로 실행 (http://localhost:5179)
 * - 처음 실행하면 master 계정을 만들고 비밀번호를 출력 (ADMIN_PASSWORD 로 정할 수 있음)
 * - server/ 코드가 바뀌면 서버 재시작, public/ 이 바뀌면 브라우저 새로고침
 */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "data");
mkdirSync(DATA, { recursive: true });

const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--watch-path=server", join("server", "index.mjs")], {
  cwd: ROOT,
  stdio: "inherit",
  env: { ...process.env, PORT: process.env.PORT || "5179", DATA_DIR: DATA, STATIC_DIR: join(ROOT, "public"), DEV: "1" }
});
child.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
