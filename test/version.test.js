import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createDemoRuntime } from "../src/demo.js";
import { createReferenceServer } from "../src/http-server.js";
import { repoPath } from "../src/rail-test-helpers.js";
import { VERSION } from "../src/version.js";

const packageVersion = JSON.parse(readFileSync(repoPath("package.json"), "utf8")).version;

test("the implementation version is read from package.json", () => {
  assert.equal(VERSION, packageVersion);
});

test("both CLIs print the implementation version", () => {
  for (const script of ["crctl.js", "rail.js"]) {
    for (const args of [["--version"], ["--version", "--port", "0x1F90"]]) {
      const result = spawnSync(process.execPath, [repoPath("cmd", script), ...args], {
        cwd: repoPath(),
        encoding: "utf8",
        timeout: 5_000,
      });
      assert.equal(result.status, 0, `${script} ${args.join(" ")}: ${result.stderr}`);
      assert.equal(result.stdout, `consequence-rail ${packageVersion}\n`);
      assert.equal(result.stderr, "");
    }
    const help = spawnSync(process.execPath, [repoPath("cmd", script), "--help"], {
      cwd: repoPath(),
      encoding: "utf8",
      timeout: 5_000,
    });
    assert.ok(help.stdout.split("\n")[0].endsWith(` ${packageVersion}`), `${script} help header`);
    assert.match(help.stdout, /--version/);
  }
});

test("the capability document advertises a declared implementation version", async (context) => {
  const openapi = JSON.parse(readFileSync(repoPath("api", "openapi.json"), "utf8"));
  const schema = openapi.paths["/.well-known/consequence-rail"].get
    .responses["200"].content["application/json"].schema;
  assert.ok(schema.required.includes("implementation_version"));

  const server = createReferenceServer({ runtime: createDemoRuntime() });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const response = await fetch(`http://127.0.0.1:${server.address().port}/.well-known/consequence-rail`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.implementation_version, packageVersion);
  assert.match(body.implementation_version, new RegExp(schema.properties.implementation_version.pattern));
  assert.equal(body.protocol_version, "v0.1");
  assert.deepEqual(
    Object.keys(body).filter((key) => !Object.hasOwn(schema.properties, key)),
    [],
    "capability document carries an undeclared field",
  );
});
