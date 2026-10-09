import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { repoPath } from "../src/rail-test-helpers.js";
import {
  compareSemVer,
  parseChangelog,
  releaseNotes,
  versionFindings,
} from "../scripts/release-metadata.js";

const read = (...segments) => readFileSync(repoPath(...segments), "utf8");

function repositoryMetadata() {
  return {
    packageVersion: JSON.parse(read("package.json")).version,
    openapiVersion: JSON.parse(read("api", "openapi.json")).info.version,
    readme: read("README.md"),
    releaseStatus: read("docs", "release-status.md"),
    changelog: read("CHANGELOG.md"),
  };
}

const FIXTURE_CHANGELOG = [
  "# Changelog",
  "",
  "## [Unreleased]",
  "",
  "## [0.2.20] - 2026-09-28",
  "",
  "- Twenty.",
  "",
  "## [0.2.19] - 2026-09-28",
  "",
  "- Nineteen.",
  "",
  "## [0.2.0] - 2026-07-27",
  "",
  "- Zero.",
  "",
  "[Unreleased]: https://example.invalid/compare",
].join("\n");

function fixture(overrides = {}) {
  return {
    packageVersion: "0.2.20",
    openapiVersion: "0.2.20",
    readme: "This checkout contains the experimental v0.2.20 source release.",
    releaseStatus: "Current public state: experimental\nv0.2.20 source release with extras.",
    changelog: FIXTURE_CHANGELOG,
    ...overrides,
  };
}

test("the repository's version surfaces agree", () => {
  assert.deepEqual(versionFindings(repositoryMetadata()), []);
  const metadata = repositoryMetadata();
  assert.deepEqual(versionFindings({ ...metadata, tag: `v${metadata.packageVersion}` }), []);
});

test("a consistent fixture yields no findings", () => {
  assert.deepEqual(versionFindings(fixture()), []);
});

test("each inconsistency yields exactly its own finding", () => {
  const cases = [
    [
      { openapiVersion: "0.2.0" },
      "api/openapi.json info.version 0.2.0 does not match package.json 0.2.20",
    ],
    [{ tag: "v0.2.19" }, "tag v0.2.19 does not match package.json version v0.2.20"],
    [
      { readme: "Experimental v0.2 reference implementation." },
      'README.md does not state "experimental v0.2.20 source release"',
    ],
    [
      { releaseStatus: "experimental v0.2.19 source release" },
      'docs/release-status.md does not state "experimental v0.2.20 source release"',
    ],
    [
      { changelog: FIXTURE_CHANGELOG.replace("## [Unreleased]\n", "") },
      'CHANGELOG.md has no "## [Unreleased]" section',
    ],
    [
      {
        changelog: FIXTURE_CHANGELOG
          .replace("## [0.2.19] - 2026-09-28", "## [0.2.21] - 2026-09-28")
          .replace("## [0.2.20] - 2026-09-28", "## [0.2.19] - 2026-09-28")
          .replace("## [0.2.21] - 2026-09-28", "## [0.2.20] - 2026-09-28"),
      },
      null,
    ],
    [
      { changelog: FIXTURE_CHANGELOG.replace("## [0.2.0] - 2026-07-27", "## [0.2.0] - 2026-10-27") },
      "CHANGELOG.md dates increase going down: 0.2.19 2026-09-28 before 0.2.0 2026-10-27",
    ],
    [
      { changelog: FIXTURE_CHANGELOG.replace("## [0.2.0] - 2026-07-27", "## [0.2.0] - 2026-02-30") },
      "CHANGELOG.md release 0.2.0 has an invalid date 2026-02-30",
    ],
    [{ packageVersion: "0.2", openapiVersion: "0.2" }, "package.json version is not SemVer: 0.2"],
  ];
  for (const [overrides, expected] of cases) {
    const findings = versionFindings(fixture(overrides));
    if (expected === null) {
      // Swapping two headings breaks both the top version and the order.
      assert.deepEqual(findings, [
        "CHANGELOG.md top release 0.2.19 does not match package.json 0.2.20",
        "CHANGELOG.md versions are not strictly descending: 0.2.19 before 0.2.20",
      ]);
    } else {
      assert.deepEqual(findings, [expected], JSON.stringify(overrides).slice(0, 80));
    }
  }
});

test("equal release dates are allowed and SemVer precedence is numeric", () => {
  assert.equal(compareSemVer("0.2.10", "0.2.9"), 1);
  assert.equal(compareSemVer("0.3.0", "0.3.0-rc.1"), 1);
  assert.equal(compareSemVer("0.3.0-rc.2", "0.3.0-rc.10"), -1);
  assert.equal(compareSemVer("1.0.0", "1.0.0"), 0);
  const parsed = parseChangelog(FIXTURE_CHANGELOG);
  assert.equal(parsed.hasUnreleased, true);
  assert.deepEqual(parsed.releases.map((item) => item.version), ["0.2.20", "0.2.19", "0.2.0"]);
  assert.equal(parsed.releases.at(-1).body, "- Zero.");
});

test("release notes come from the matching CHANGELOG section", () => {
  const changelog = read("CHANGELOG.md");
  const top = parseChangelog(changelog).releases[0];
  const notes = releaseNotes(changelog, top.version);
  assert.ok(notes.length > 0);
  assert.equal(notes, top.body);
  assert.doesNotMatch(notes, /^## /m);
  assert.doesNotMatch(notes, /^\[[^\]]+\]: /m);
  assert.equal(releaseNotes(changelog, "9.9.9"), null);

  const run = (...args) => spawnSync(process.execPath, [repoPath("scripts", "release-notes.js"), ...args], {
    cwd: repoPath(),
    encoding: "utf8",
    timeout: 5_000,
  });
  const printed = run(`v${top.version}`);
  assert.equal(printed.status, 0, printed.stderr);
  assert.equal(printed.stdout, `${notes}\n`);
  for (const args of [["v9.9.9"], [top.version], []]) {
    const refused = run(...args);
    assert.equal(refused.status, 1, args.join(" "));
    assert.equal(refused.stdout, "");
  }
});

test("the repository check enforces the tag only in tag builds", () => {
  const metadata = repositoryMetadata();
  const check = (env) => spawnSync(process.execPath, [repoPath("scripts", "check.js")], {
    cwd: repoPath(),
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, GITHUB_REF_TYPE: "", GITHUB_REF_NAME: "", ...env },
  });
  const plain = check({});
  assert.equal(plain.status, 0, plain.stderr);
  assert.match(plain.stdout, /^version_consistency: pass$/m);
  assert.equal(check({ GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: `v${metadata.packageVersion}` }).status, 0);
  const wrongTag = check({ GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v9.9.9" });
  assert.equal(wrongTag.status, 1);
  assert.match(wrongTag.stderr, /tag v9\.9\.9 does not match/);
  assert.equal(check({ GITHUB_REF_TYPE: "branch", GITHUB_REF_NAME: "v9.9.9" }).status, 0);
});
