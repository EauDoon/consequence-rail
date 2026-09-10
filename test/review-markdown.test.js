import assert from "node:assert/strict";
import test from "node:test";
import { runRefundDemo } from "../src/demo.js";
import { runRecoveryPreflightDemo } from "../src/recovery-demo.js";
import { demoTrustedKeys, demoConnectorTrustedKeys, demoRecoveryTrustedKeys } from "../src/signing.js";
import { settlementMarkdown, recoveryMarkdown } from "../src/review-markdown.js";

test("Markdown reports verify input and retain scope, freshness and limitations", async () => {
  const settlement = (await runRefundDemo({ fault: "duplicate" })).bundle;
  const markdown = settlementMarkdown(settlement, { trustedKeys: demoTrustedKeys(), trustedConnectorKeys: demoConnectorTrustedKeys() });
  assert.match(markdown, /compensated/); assert.match(markdown, /public demonstration keys only/);
  assert(!markdown.includes("ord_demo_42")); assert(!markdown.includes("<"));
  assert.throws(() => settlementMarkdown(settlement));
  const recovery = (await runRecoveryPreflightDemo({ fault: "remedy-failure" })).bundle;
  const drill = recoveryMarkdown(recovery, { trustedKeys: demoRecoveryTrustedKeys() });
  assert.match(drill, /NOT&#95;QUALIFIED/); assert.match(drill, /Freshness was not checked/);
  assert.match(drill, /not satisfied/); assert(!drill.includes("ord_demo_42"));
  assert.throws(() => recoveryMarkdown(recovery));
});
