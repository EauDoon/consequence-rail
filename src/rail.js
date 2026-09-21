// Thin re-export shim. The orchestrator and its data live in focused
// sibling files: schemas in src/rail-schema.js, state machine in
// src/rail-state.js, and the class in src/rail-class.js. This file
// preserves the public API of src/rail.js unchanged.

export { ASSURANCE_MODES, ALLOWED_TRANSITIONS } from "./rail-state.js";
export { recourseScopeField } from "./rail-schema.js";
export { ConsequenceRail } from "./rail-class.js";
