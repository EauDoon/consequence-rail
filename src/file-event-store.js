// A durable, append-only event store: one JSON Lines file per stream (an
// action or a plan). It keeps the same contract as MemoryEventStore, so a
// rail can swap it in without other changes:
//
// - append is failure-atomic. It writes one line, fsyncs it, and returns. If
//   the write or the fsync throws, the file is cut back to its earlier length
//   and the in-memory copy is not changed.
// - Opening a directory loads every stream and checks each hash chain and
//   signature. A torn or edited line stops the open with EVENT_LOG_CORRUPT;
//   the store never drops a line to make a chain fit.
// - One process holds the directory at a time, through an exclusive lock
//   file. A second open gets EVENT_LOG_LOCKED until close() releases it.
//
// This store keeps history across restarts. It does not rebuild a rail's
// in-memory action records from that history: a restarted rail refuses to
// propose an action whose stream already exists (ACTION_EXISTS), so a crash
// can never lead to the same action running twice.

import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { deepClone } from "./canonical.js";
import { RailError } from "./errors.js";
import { buildEvent, verifyEventChain } from "./event-store.js";

export const STREAM_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
const LOCK_FILE = ".lock";
const STREAM_SUFFIX = ".jsonl";

function fsyncDirectory(dir) {
  // Directory fsync makes a newly created file name durable on POSIX. Windows
  // cannot open a directory for this, and does not need it.
  let fd;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    // Not supported on this platform.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export class FileEventStore {
  /**
   * @param {object} options
   * @param {string} options.dir Directory that holds the stream files.
   * @param {object} options.signer The rail's signer; it signs new events and
   *   its public key checks the loaded ones.
   * @param {object} options.clock The rail's clock.
   * @param {Map} [options.trustedKeys] Extra keys accepted on load, for a log
   *   written before a key rotation.
   */
  constructor({ dir, signer, clock, trustedKeys } = {}) {
    if (typeof dir !== "string" || dir.length === 0) {
      throw new RailError("CONFIG_INVALID", "FileEventStore needs a directory.");
    }
    if (!signer?.kid || !signer?.publicKey || !clock) {
      throw new RailError("CONFIG_INVALID", "FileEventStore needs the rail's signer and clock.");
    }
    Object.defineProperty(this, "failureAtomicAppend", { value: true, enumerable: true });
    this.dir = dir;
    this.signer = signer;
    this.clock = clock;
    this.closed = false;
    mkdirSync(dir, { recursive: true });
    this.lockPath = join(dir, LOCK_FILE);
    try {
      const fd = openSync(this.lockPath, "wx");
      writeSync(fd, `${process.pid}\n`);
      fsyncSync(fd);
      closeSync(fd);
    } catch (error) {
      if (error?.code === "EEXIST") {
        throw new RailError(
          "EVENT_LOG_LOCKED",
          "Another rail holds this event log. Close it first, or remove a stale .lock after checking no process uses it.",
          { dir },
        );
      }
      throw error;
    }
    try {
      this.byAction = this.load(new Map([
        ...(trustedKeys ?? []),
        [signer.kid, signer.publicKey],
      ]));
    } catch (error) {
      this.close();
      throw error;
    }
  }

  load(keys) {
    const streams = new Map();
    for (const name of readdirSync(this.dir).sort()) {
      if (!name.endsWith(STREAM_SUFFIX)) continue;
      const streamId = name.slice(0, -STREAM_SUFFIX.length);
      const text = readFileSync(join(this.dir, name), "utf8");
      const corrupt = (reason) =>
        new RailError("EVENT_LOG_CORRUPT", `Event log ${name} is corrupt: ${reason}`, { stream: streamId });
      if (!STREAM_ID_PATTERN.test(streamId)) throw corrupt("the file name is not a stream id.");
      if (text.length === 0) continue;
      if (!text.endsWith("\n")) throw corrupt("the last line is torn.");
      const events = [];
      for (const line of text.slice(0, -1).split("\n")) {
        try {
          events.push(JSON.parse(line));
        } catch {
          throw corrupt(`line ${events.length + 1} is not JSON.`);
        }
      }
      try {
        verifyEventChain(events, keys);
      } catch (error) {
        throw corrupt(error.message);
      }
      if (events[0].action_id !== streamId) throw corrupt("the events belong to another stream.");
      streams.set(streamId, events);
    }
    return streams;
  }

  assertOpen() {
    if (this.closed) throw new RailError("EVENT_LOG_CLOSED", "The event log is closed.");
  }

  append(actionId, eventType, actor, payload) {
    this.assertOpen();
    if (typeof actionId !== "string" || !STREAM_ID_PATTERN.test(actionId)) {
      throw new RailError("SCHEMA_INVALID", "Event stream id is not a safe file name.");
    }
    const events = this.byAction.get(actionId) ?? [];
    const event = buildEvent(this.signer, this.clock, actionId, events.at(-1), eventType, actor, payload);
    const line = Buffer.from(`${JSON.stringify(event)}\n`, "utf8");
    const path = join(this.dir, `${actionId}${STREAM_SUFFIX}`);
    const isNew = !existsSync(path);
    const fd = openSync(path, "a");
    let size;
    try {
      size = fstatSync(fd).size;
      let written = 0;
      while (written < line.length) {
        written += writeSync(fd, line, written, line.length - written);
      }
      fsyncSync(fd);
    } catch (error) {
      // Undo a partial line so the file still ends on a whole event.
      if (size !== undefined) {
        try {
          ftruncateSync(fd, size);
          fsyncSync(fd);
        } catch {
          // The next open reports the torn line as EVENT_LOG_CORRUPT.
        }
      }
      throw error;
    } finally {
      closeSync(fd);
    }
    if (isNew) fsyncDirectory(this.dir);
    this.byAction.set(actionId, [...events, event]);
    return deepClone(event);
  }

  list(actionId) {
    return deepClone(this.byAction.get(actionId) ?? []);
  }

  /** Stream ids with history, actions and plans alike. */
  streams() {
    return [...this.byAction.keys()];
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      unlinkSync(this.lockPath);
    } catch {
      // Already gone.
    }
  }
}
