// Pure release-metadata checks shared by scripts/check.js, the release-notes
// CLI and the tests. This module performs no I/O and has no main-module entry
// point, so importing it never runs anything.

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const RELEASE_HEADING =
  /^## \[(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\] - (\d{4}-\d{2}-\d{2})$/;
const UNRELEASED_HEADING = "## [Unreleased]";

export function isSemVer(value) {
  return typeof value === "string" && SEMVER.test(value);
}

function isCalendarDate(value) {
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function compareIdentifiers(left, right) {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) return Math.sign(Number(left) - Number(right));
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

/** SemVer 2.0.0 precedence: negative, zero or positive like a comparator. */
export function compareSemVer(left, right) {
  const a = SEMVER.exec(left);
  const b = SEMVER.exec(right);
  if (!a || !b) throw new TypeError("compareSemVer requires two SemVer strings.");
  for (let index = 1; index <= 3; index += 1) {
    const difference = Math.sign(Number(a[index]) - Number(b[index]));
    if (difference !== 0) return difference;
  }
  if (a[4] === undefined || b[4] === undefined) {
    if (a[4] === b[4]) return 0;
    return a[4] === undefined ? 1 : -1;
  }
  const leftParts = a[4].split(".");
  const rightParts = b[4].split(".");
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    if (leftParts[index] === undefined) return -1;
    if (rightParts[index] === undefined) return 1;
    const difference = compareIdentifiers(leftParts[index], rightParts[index]);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * Split a Keep a Changelog document into its Unreleased marker and its
 * released sections, newest first as written.
 */
export function parseChangelog(text) {
  const lines = String(text).split(/\r?\n/);
  const releases = [];
  let hasUnreleased = false;
  let current = null;
  const finish = () => {
    if (!current) return;
    while (current.lines.length > 0 && current.lines.at(-1).trim() === "") current.lines.pop();
    while (current.lines.length > 0 && current.lines[0].trim() === "") current.lines.shift();
    releases.push({ version: current.version, date: current.date, body: current.lines.join("\n") });
    current = null;
  };
  for (const line of lines) {
    if (line.startsWith("## ") || /^\[[^\]]+\]: \S/.test(line)) {
      finish();
      if (line === UNRELEASED_HEADING) {
        hasUnreleased = true;
        continue;
      }
      const match = RELEASE_HEADING.exec(line);
      if (match) current = { version: match[1], date: match[2], lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  finish();
  return { hasUnreleased, releases };
}

function mentionsSourceRelease(text, version) {
  return String(text).replace(/\s+/g, " ").includes(`experimental v${version} source release`);
}

/**
 * Return one human-readable finding per version inconsistency. An empty
 * array means every version surface agrees.
 */
export function versionFindings({
  packageVersion,
  openapiVersion,
  readme,
  releaseStatus,
  changelog,
  tag = null,
}) {
  const findings = [];
  if (!isSemVer(packageVersion)) {
    findings.push(`package.json version is not SemVer: ${packageVersion}`);
    return findings;
  }
  if (openapiVersion !== packageVersion) {
    findings.push(
      `api/openapi.json info.version ${openapiVersion} does not match package.json ${packageVersion}`,
    );
  }
  if (!mentionsSourceRelease(readme, packageVersion)) {
    findings.push(`README.md does not state "experimental v${packageVersion} source release"`);
  }
  if (!mentionsSourceRelease(releaseStatus, packageVersion)) {
    findings.push(
      `docs/release-status.md does not state "experimental v${packageVersion} source release"`,
    );
  }
  const { hasUnreleased, releases } = parseChangelog(changelog);
  if (!hasUnreleased) {
    findings.push("CHANGELOG.md has no \"## [Unreleased]\" section");
  }
  if (releases.length === 0) {
    findings.push("CHANGELOG.md has no \"## [X.Y.Z] - YYYY-MM-DD\" release heading");
  } else if (releases[0].version !== packageVersion) {
    findings.push(
      `CHANGELOG.md top release ${releases[0].version} does not match package.json ${packageVersion}`,
    );
  }
  releases.forEach((release, index) => {
    if (!isSemVer(release.version)) {
      findings.push(`CHANGELOG.md release heading ${release.version} is not SemVer`);
    }
    if (!isCalendarDate(release.date)) {
      findings.push(`CHANGELOG.md release ${release.version} has an invalid date ${release.date}`);
    }
    const next = releases[index + 1];
    if (!next) return;
    if (
      isSemVer(release.version) &&
      isSemVer(next.version) &&
      compareSemVer(release.version, next.version) <= 0
    ) {
      findings.push(
        `CHANGELOG.md versions are not strictly descending: ${release.version} before ${next.version}`,
      );
    }
    if (isCalendarDate(release.date) && isCalendarDate(next.date) && release.date < next.date) {
      findings.push(
        `CHANGELOG.md dates increase going down: ${release.version} ${release.date} before ${next.version} ${next.date}`,
      );
    }
  });
  if (tag !== null && tag !== undefined && tag !== `v${packageVersion}`) {
    findings.push(`tag ${tag} does not match package.json version v${packageVersion}`);
  }
  return findings;
}

/** The body of one released CHANGELOG section, or null when it is absent. */
export function releaseNotes(changelog, version) {
  const release = parseChangelog(changelog).releases.find((item) => item.version === version);
  return release ? release.body : null;
}
