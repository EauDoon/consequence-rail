// Permit ledgers make the single-use permit single-use across processes, not
// only inside one rail. consume() records a permit's jti and returns true the
// first time, and false every later time, with no window between the check
// and the record. The rail calls it before it moves an action to EXECUTING
// and before it calls the connector; a false answer is PERMIT_USED.
//
// A consumed permit that then fails to execute stays consumed. That is the
// safe direction: a lost permit costs a new authorization, a reused one
// could repeat the effect.

import { createHash } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { RailError } from "./errors.js";

function assertEntry({ jti, action_digest: actionDigest, expires_at: expiresAt } = {}) {
  if (typeof jti !== "string" || jti.length === 0 || typeof actionDigest !== "string" || typeof expiresAt !== "string") {
    throw new RailError("SCHEMA_INVALID", "A permit ledger entry needs jti, action_digest and expires_at.");
  }
}

export class MemoryPermitLedger {
  constructor() {
    this.consumed = new Map();
  }

  consume(entry) {
    assertEntry(entry);
    if (this.consumed.has(entry.jti)) return false;
    this.consumed.set(entry.jti, { ...entry });
    return true;
  }

  has(jti) {
    return this.consumed.has(jti);
  }
}

/**
 * A ledger that several rail processes on one host, or on one shared file
 * system with exclusive-create semantics, can share. Each consumed jti is one
 * file created with O_CREAT | O_EXCL, so exactly one creator wins.
 */
export class FilePermitLedger {
  constructor({ dir, clock } = {}) {
    if (typeof dir !== "string" || dir.length === 0) {
      throw new RailError("CONFIG_INVALID", "FilePermitLedger needs a directory.");
    }
    this.dir = dir;
    this.clock = clock ?? null;
    mkdirSync(dir, { recursive: true });
  }

  pathFor(jti) {
    return join(this.dir, `${createHash("sha256").update(jti, "utf8").digest("hex")}.json`);
  }

  consume(entry) {
    assertEntry(entry);
    let fd;
    try {
      fd = openSync(this.pathFor(entry.jti), "wx");
    } catch (error) {
      if (error?.code === "EEXIST") return false;
      throw error;
    }
    try {
      writeSync(fd, `${JSON.stringify({
        jti: entry.jti,
        action_digest: entry.action_digest,
        expires_at: entry.expires_at,
        consumed_at: this.clock ? this.clock.now() : new Date().toISOString(),
      })}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // The name is the claim. Even if the content write failed above, the
    // file exists and the permit stays consumed.
    return true;
  }

  has(jti) {
    try {
      closeSync(openSync(this.pathFor(jti), "r"));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Remove entries whose permit expired before `now`. An expired permit is
   * refused on its own expiry, so its entry is no longer needed. Unreadable
   * entries are kept.
   */
  prune(now) {
    const cutoff = Date.parse(now);
    if (!Number.isFinite(cutoff)) throw new RailError("SCHEMA_INVALID", "prune needs an ISO time.");
    let removed = 0;
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith(".json")) continue;
      const path = join(this.dir, name);
      try {
        const { expires_at: expiresAt } = JSON.parse(readFileSync(path, "utf8"));
        if (Date.parse(expiresAt) < cutoff) {
          unlinkSync(path);
          removed += 1;
        }
      } catch {
        // Keep anything this method cannot read.
      }
    }
    return removed;
  }
}
