import { deepClone, deepFreeze, digest, without } from "./canonical.js";
import { RailError } from "./errors.js";
import { signArtifact, verifyArtifact } from "./signing.js";

export class MemoryEventStore {
  constructor(signer, clock) {
    Object.defineProperty(this, "failureAtomicAppend", {
      value: true,
      enumerable: true,
    });
    this.signer = signer;
    this.clock = clock;
    this.byAction = new Map();
  }

  append(actionId, eventType, actor, payload) {
    const events = this.byAction.get(actionId) ?? [];
    const previous = events.at(-1);
    const unsigned = {
      schema_version: "consequence-rail/event/v0.1",
      action_id: actionId,
      sequence: events.length,
      previous_hash: previous?.event_hash ?? null,
      event_type: eventType,
      actor,
      recorded_at: this.clock.now(),
      payload: deepClone(payload),
    };
    const signed = signArtifact(unsigned, this.signer);
    const event = deepFreeze({
      ...signed,
      event_hash: digest(signed),
    });
    const returnedEvent = deepClone(event);
    const nextEvents = [...events, event];
    this.byAction.set(actionId, nextEvents);
    return returnedEvent;
  }

  list(actionId) {
    return deepClone(this.byAction.get(actionId) ?? []);
  }
}

export function verifyEventChain(events, trustedKeys) {
  let previousHash = null;
  // Every event in a chain must belong to the same action. A chain that is
  // internally consistent but stitched from two actions is not that action's
  // history, so the binding is checked before linkage is trusted.
  const actionId = events[0]?.action_id;

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (typeof event.action_id !== "string" || event.action_id !== actionId) {
      throw new RailError("BUNDLE_TAMPERED", "Event action binding is invalid.", {
        sequence: index,
      });
    }
    if (event.sequence !== index || event.previous_hash !== previousHash) {
      throw new RailError("BUNDLE_TAMPERED", "Event ordering or chain linkage is invalid.", {
        sequence: index,
      });
    }

    const signed = without(event, ["event_hash"]);
    try {
      verifyArtifact(signed, trustedKeys);
    } catch (error) {
      if (error.code === "UNTRUSTED_KEY") {
        throw error;
      }
      throw new RailError("BUNDLE_TAMPERED", "Event signature verification failed.", {
        sequence: index,
      });
    }
    const expectedHash = digest(signed);
    if (event.event_hash !== expectedHash) {
      throw new RailError("BUNDLE_TAMPERED", "Event content does not match its digest.", {
        sequence: index,
      });
    }
    previousHash = event.event_hash;
  }

  return {
    valid: true,
    event_count: events.length,
    chain_head: previousHash,
  };
}
