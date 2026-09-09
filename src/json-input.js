import { JSON_LIMITS } from "./canonical.js";
import { RailError } from "./errors.js";

/** Parse valid JSON while rejecting duplicate object members, including escaped names. */
export function parseUniqueJson(text) {
  const value = JSON.parse(text);
  const stack = [];
  // Tokenize strings as complete JSON tokens, so braces inside strings have no effect.
  for (const match of text.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]]/g)) {
    const token = match[0];
    if (token === "{" || token === "[") {
      stack.push(token === "{" ? new Set() : null);
      if (stack.length > JSON_LIMITS.maxDepth + 1) {
        throw new RailError("CANONICALIZATION_FAILED", "JSON depth limit exceeded.");
      }
    } else if (token === "}" || token === "]") {
      stack.pop();
    } else {
      let next = match.index + token.length;
      while (next < text.length && /\s/.test(text[next])) next++;
      if (text[next] !== ":") continue;
      const keys = stack.at(-1);
      const key = JSON.parse(token);
      if (keys.has(key)) throw new RailError("JSON_DUPLICATE_KEY", "Duplicate JSON object members are not accepted.");
      keys.add(key);
    }
  }
  return value;
}
