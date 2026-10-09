// Executes the README's "Expected result:" examples so the first commands a
// reader runs cannot drift from the real output.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { repoPath } from "../src/rail-test-helpers.js";

function readmeExamples() {
  const lines = readFileSync(repoPath("README.md"), "utf8").split(/\r?\n/);
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index] !== "```text") continue;
    const start = index + 1;
    let end = start;
    while (end < lines.length && lines[end] !== "```") end += 1;
    blocks.push({ start: index, end, body: lines.slice(start, end) });
    index = end;
  }
  const examples = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index] !== "Expected result:") continue;
    const command = [...blocks].reverse().find((block) => block.end < index);
    const output = blocks.find((block) => block.start > index);
    assert.ok(command && output, `README line ${index + 1} has no command and output blocks`);
    const commandLine = [...command.body].reverse().find((line) => line.startsWith("node ./cmd/crctl.js "));
    assert.ok(commandLine, `README line ${index + 1} is not preceded by a crctl command`);
    examples.push({ line: index + 1, commandLine, expected: output.body.join("\n") });
  }
  return examples;
}

test("README expected-result blocks match real crctl output", () => {
  const examples = readmeExamples();
  assert.ok(examples.length >= 2, `found ${examples.length} README examples`);
  for (const { line, commandLine, expected } of examples) {
    const [, script, ...args] = commandLine.split(/\s+/);
    const result = spawnSync(process.execPath, [repoPath(script), ...args], {
      cwd: repoPath(),
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.status, 0, `${commandLine} (README line ${line}): ${result.stderr}`);
    assert.equal(
      result.stdout.replace(/\r\n/g, "\n"),
      `${expected}\n`,
      `${commandLine} output differs from README line ${line}`,
    );
  }
});
