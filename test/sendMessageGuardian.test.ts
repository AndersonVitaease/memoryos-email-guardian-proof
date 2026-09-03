/**
 * GC-06 — blind fourth-domain validation: OUTBOUND EMAIL / sendMessage.
 *
 * Every test below was derived from Guardian Core v0.1 only (contract in
 * src/guardianCore.ts + README). No real Gmail, no SMTP, no network: the
 * provider is a deterministic in-process fake.
 */

import { describe, expect, it } from "vitest";
import {
  type DomainAdapter,
  type GuardianResult,
  executeGuardianIntent,
} from "../../memoryos-guardian-core/src/guardianCore";
import { FakeEmailProvider, type ProviderScript } from "../src/emailProvider";
import {
  createEmailGuardianAdapter,
  type SendMessageIntent,
  type SendMessageProposal,
} from "../src/emailGuardianAdapter";

// ---------------------------------------------------------------------------
// TYPE-LEVEL AUTHORITY NEGATIVES (checked by `npm run typecheck`, not at runtime).
// The intent type cannot express machinery: each forbidden field below is a
// compile error when assigned to a sendMessage intent.
// ---------------------------------------------------------------------------
const typeNegatives = (): void => {
  const base = { messageId: "m", to: "alice@example.test", subject: "s", body: "b" };
  const withCredential: SendMessageIntent = {
    ...base,
    // @ts-expect-error — a credential must NOT be expressible on a sendMessage intent
    credential: "hunter2",
  };
  const withTransport: SendMessageIntent = {
    ...base,
    // @ts-expect-error — a transport must NOT be expressible on a sendMessage intent
    transport: "smtp://attacker.test:587",
  };
  const withProviderUrl: SendMessageIntent = {
    ...base,
    // @ts-expect-error — a provider URL must NOT be expressible on a sendMessage intent
    providerUrl: "https://attacker.test/send",
  };
  const withRawPayload: SendMessageIntent = {
    ...base,
    // @ts-expect-error — a raw provider payload must NOT be expressible on a sendMessage intent
    providerPayload: { rawMime: "DATA\r\n." },
  };
  void [withCredential, withTransport, withProviderUrl, withRawPayload];
};
typeNegatives();

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
let tick = 0;
function deterministicNow(): string {
  tick += 1;
  return new Date(Date.UTC(2026, 0, 1, 0, 0, 0, tick)).toISOString();
}

const RECIPIENTS = ["alice@example.test", "bob@example.test"];

function makeWorld(options?: {
  script?: ProviderScript;
  recipients?: readonly string[];
  sendTimeoutMs?: number;
}): {
  provider: FakeEmailProvider;
  adapter: DomainAdapter<SendMessageIntent, SendMessageProposal>;
  intent: SendMessageIntent;
} {
  const provider = new FakeEmailProvider(options?.script ?? { mode: "accept" }, deterministicNow);
  const adapter = createEmailGuardianAdapter({
    provider,
    allowedRecipients: options?.recipients ?? RECIPIENTS,
    sendTimeoutMs: options?.sendTimeoutMs,
  });
  const intent: SendMessageIntent = {
    messageId: "msg-001",
    to: "alice@example.test",
    subject: "Quarterly report",
    body: "Hello Alice, attached is the quarterly report.",
  };
  return { provider, adapter, intent };
}

function isSuccess(result: GuardianResult): boolean {
  return result.outcome === "SUCCESS_PROVEN";
}

// ---------------------------------------------------------------------------
// Mandatory tests (1-10) + supporting honesty tests
// ---------------------------------------------------------------------------
describe("GC-06 blind fourth-domain validation — OUTBOUND EMAIL / sendMessage", () => {
  it("TEST 1 — eligible bind sends nothing: BOUND, zero dispatch, empty outbox, read-only observation", async () => {
    const { provider, adapter, intent } = makeWorld();

    const bound = await adapter.bind(intent);

    expect("status" in bound && bound.status === "BOUND").toBe(true);
    if (!("status" in bound)) return;
    expect(bound.proposal.observation.messageIdAbsentFromOutbox).toBe(true);
    expect(Object.isFrozen(bound.proposal)).toBe(true);
    // bind is read-only: no transport call, no outbox mutation.
    expect(provider.sendCalls).toBe(0);
    expect(provider.outbox.length).toBe(0);
    expect(provider.readCalls).toBe(1);
  });

  it("TEST 2 — recipient outside operator authority: NOT_EXECUTED/ELIGIBILITY, zero dispatch", async () => {
    const { provider, adapter, intent } = makeWorld();

    const result = await executeGuardianIntent(
      { ...intent, to: "mallory@elsewhere.test" },
      adapter,
    );

    expect(result).toEqual({
      outcome: "NOT_EXECUTED",
      stage: "ELIGIBILITY",
      refusal: "BLOCKED",
      effect: { dispatched: false, state: "NONE_PROVEN" },
      reasons: ["RECIPIENT_NOT_IN_ALLOWED_SCOPE", "mallory@elsewhere.test"],
    });
    expect(provider.sendCalls).toBe(0);
    expect(provider.outbox.length).toBe(0);
  });

  it("TEST 3 — stale decision: relevant state changes between bind and apply → naturally blocked, zero dispatch", async () => {
    const { provider, adapter, intent } = makeWorld({ script: { mode: "accept" } });

    const bound = await adapter.bind(intent); // decision bound to: messageId absent from outbox
    if (!("status" in bound)) throw new Error("expected BOUND");
    // Before apply, ANOTHER actor sends the same message (state changed).
    await provider.injectConcurrentSend({
      messageId: intent.messageId,
      to: intent.to,
      subject: intent.subject,
      body: intent.body,
    });

    // The Core would forward this exact proposal unchanged; apply must re-prove it.
    const result = await adapter.apply(bound.proposal);

    expect(result).toEqual({
      outcome: "NOT_EXECUTED",
      stage: "COMPATIBILITY",
      refusal: "BLOCKED",
      effect: { dispatched: true, state: "NONE_PROVEN" },
      reasons: ["BINDING_INVALIDATED", "MESSAGE_ID_ALREADY_PRESENT_IN_OUTBOX"],
    });
    // The stale decision NEVER dispatched a send — no duplicate.
    expect(provider.sendCalls).toBe(0);
    expect(provider.outbox.length).toBe(1); // only the concurrent actor's entry
  });

  it("TEST 4 — valid send dispatches EXACTLY once", async () => {
    const { provider, adapter, intent } = makeWorld();

    const result = await executeGuardianIntent(intent, adapter);

    expect(isSuccess(result)).toBe(true);
    expect(provider.sendCalls).toBe(1);
    expect(provider.outbox.length).toBe(1);
    const entry = provider.outbox[0];
    expect(entry?.messageId).toBe("msg-001");
    expect(entry?.to).toBe("alice@example.test");
    // Observation chain: bind read + apply re-proof + postcondition read.
    expect(provider.readCalls).toBe(3);
  });

  it("TEST 5 — provider acceptance without sufficient proof is NEVER SUCCESS_PROVEN", async () => {
    const { provider, adapter, intent } = makeWorld({ script: { mode: "accept-and-drop" } });

    const result = await executeGuardianIntent(intent, adapter);

    expect(result.outcome).toBe("INDETERMINATE");
    expect(result.outcome).not.toBe("SUCCESS_PROVEN");
    expect(result).toEqual({
      outcome: "INDETERMINATE",
      effect: { dispatched: true, state: "UNDETERMINED" },
      reasons: ["ACCEPTED_WITHOUT_SUFFICIENT_REGISTRATION_PROOF"],
    });
    expect(provider.sendCalls).toBe(1); // dispatched, outcome unknowable
    expect(provider.outbox.length).toBe(0); // and honestly unproven
  });

  it("TEST 6 — postcondition sufficiently proven → SUCCESS_PROVEN with outbox evidence", async () => {
    const { adapter, intent } = makeWorld();

    const result = await executeGuardianIntent(intent, adapter);

    expect(result).toEqual({
      outcome: "SUCCESS_PROVEN",
      effect: { dispatched: true, state: "OCCURRED" },
      evidence: {
        kind: "outbox-post-read",
        messageId: "msg-001",
        providerId: "prov-msg-001",
        queuedAt: expect.any(String),
        recipient: "alice@example.test",
      },
    });
  });

  it("TEST 7 — postcondition proven NOT reached → FAILURE_PROVEN, only because it is really proven", async () => {
    const { provider, adapter, intent } = makeWorld({
      script: { mode: "reject", reason: "RECIPIENT_BLOCKED_BY_PROVIDER_POLICY" },
    });

    const result = await executeGuardianIntent(intent, adapter);

    expect(result.outcome).toBe("FAILURE_PROVEN");
    if (result.outcome !== "FAILURE_PROVEN") return;
    expect(result.effect).toEqual({ dispatched: true, state: "NONE_PROVEN" });
    expect(result.evidence).toEqual({
      kind: "provider-rejection",
      rejection: "RECIPIENT_BLOCKED_BY_PROVIDER_POLICY",
      outboxPostRead: "absent",
    });
    expect(result.reasons).toEqual(["PROVIDER_REJECTED_DELIVERY", "RECIPIENT_BLOCKED_BY_PROVIDER_POLICY"]);
    expect(provider.sendCalls).toBe(1);
    expect(provider.outbox.length).toBe(0);
  });

  it("TEST 8 — timeout after possible dispatch → INDETERMINATE (dispatched=true, UNDETERMINED)", async () => {
    const { provider, adapter, intent } = makeWorld({ script: { mode: "hang" }, sendTimeoutMs: 25 });

    const result = await executeGuardianIntent(intent, adapter);

    expect(result).toEqual({
      outcome: "INDETERMINATE",
      effect: { dispatched: true, state: "UNDETERMINED" },
      reasons: ["APPLY_FAILED", "PROVIDER_SEND_TIMEOUT"],
    });
    expect(result.outcome).not.toBe("SUCCESS_PROVEN");
    expect(result.outcome).not.toBe("FAILURE_PROVEN");
    expect(provider.sendCalls).toBe(1); // dispatched into the unknown, exactly once
    expect(provider.outbox.length).toBe(0);
  });

  it("TEST 9 — NO automatic retry anywhere: one send attempt per run even on failure (no duplicate risk)", async () => {
    // Timeout path: one attempt, then honest INDETERMINATE — never a second send.
    const hung = makeWorld({ script: { mode: "hang" }, sendTimeoutMs: 25 });
    await executeGuardianIntent(hung.intent, hung.adapter);
    expect(hung.provider.sendCalls).toBe(1);

    // Definitive-rejection path: one attempt, FAILURE_PROVEN, never re-sent.
    const rejected = makeWorld({ script: { mode: "reject", reason: "RECIPIENT_BLOCKED_BY_PROVIDER_POLICY" } });
    const failure = await executeGuardianIntent(rejected.intent, rejected.adapter);
    expect(failure.outcome).toBe("FAILURE_PROVEN");
    expect(rejected.provider.sendCalls).toBe(1);
    expect(rejected.provider.outbox.length).toBe(0);

    // Stale-decision path: zero sends, nothing duplicated.
    const stale = makeWorld();
    const bound = await stale.adapter.bind(stale.intent);
    if (!("status" in bound)) throw new Error("expected BOUND");
    await stale.provider.injectConcurrentSend({ ...stale.intent, to: stale.intent.to });
    const compat = await stale.adapter.apply(bound.proposal);
    expect(compat.outcome).toBe("NOT_EXECUTED");
    expect(stale.provider.sendCalls).toBe(0);
  });

  it("TEST 10 — caller cannot supply authority: forbidden intent fields refused + structural surface", async () => {
    const { provider, adapter, intent } = makeWorld();

    // Runtime: an intent carrying machinery is refused before anything happens.
    const malicious = {
      messageId: "msg-evil",
      to: "alice@example.test",
      subject: "s",
      body: "b",
      credential: "hunter2",
      transport: "smtp://attacker.test:587",
      providerUrl: "https://attacker.test/send",
      providerPayload: { rawMime: "DATA" },
    } as unknown as SendMessageIntent;
    const result = await adapter.bind(malicious);

    expect(result).toEqual({
      outcome: "NOT_EXECUTED",
      stage: "ELIGIBILITY",
      refusal: "BLOCKED",
      effect: { dispatched: false, state: "NONE_PROVEN" },
      reasons: [
        "INTENT_CARRIES_FORBIDDEN_AUTHORITY",
        "credential",
        "transport",
        "providerUrl",
        "providerPayload",
      ],
    });
    expect(provider.sendCalls).toBe(0);
    expect(provider.readCalls).toBe(0); // refused before any provider interaction

    // Structural: the guardian surface is exactly (intent, adapter)...
    expect(executeGuardianIntent.length).toBe(2);
    // ...and the adapter exposes exactly bind/apply — nothing else.
    const adapterKeys: Record<keyof DomainAdapter<SendMessageIntent, SendMessageProposal>, true> = {
      bind: true,
      apply: true,
    };
    expect(Object.keys(adapterKeys).sort()).toEqual(["apply", "bind"]);
    void intent;
  });

  // -------------------------------------------------------------------------
  // Supporting honesty tests (derived from the same Core contract)
  // -------------------------------------------------------------------------
  it("SUPPORT A — messageId already sent before the run: eligibility refuses, zero dispatch (no duplicate)", async () => {
    const { provider, adapter, intent } = makeWorld();
    await provider.injectConcurrentSend({ ...intent, to: intent.to });

    const result = await executeGuardianIntent(intent, adapter);

    expect(result).toEqual({
      outcome: "NOT_EXECUTED",
      stage: "ELIGIBILITY",
      refusal: "BLOCKED",
      effect: { dispatched: false, state: "NONE_PROVEN" },
      reasons: ["MESSAGE_ID_ALREADY_SENT"],
    });
    expect(provider.sendCalls).toBe(0);
    expect(provider.outbox.length).toBe(1);
  });

  it("SUPPORT B — observation machinery unavailable at bind: NOT_EXECUTED/OBSERVATION/UNDETERMINED, zero dispatch", async () => {
    const { provider, adapter, intent } = makeWorld();
    provider.failReads();

    const result = await executeGuardianIntent(intent, adapter);

    expect(result).toEqual({
      outcome: "NOT_EXECUTED",
      stage: "OBSERVATION",
      refusal: "UNDETERMINED",
      effect: { dispatched: false, state: "NONE_PROVEN" },
      reasons: ["OUTBOX_OBSERVATION_UNAVAILABLE", "OUTBOX_READ_UNAVAILABLE"],
    });
    expect(provider.sendCalls).toBe(0);
  });

  it("SUPPORT C — accepted but postcondition read unavailable: INDETERMINATE, never SUCCESS_PROVEN", async () => {
    const { provider, adapter, intent } = makeWorld({ script: { mode: "accept" } });
    provider.failReadsFromSend(1); // reads fail once the send happened

    const result = await executeGuardianIntent(intent, adapter);

    expect(result).toEqual({
      outcome: "INDETERMINATE",
      effect: { dispatched: true, state: "UNDETERMINED" },
      reasons: ["POSTCONDITION_OBSERVATION_UNAVAILABLE", "OUTBOX_READ_UNAVAILABLE"],
    });
    expect(result.outcome).not.toBe("SUCCESS_PROVEN");
    expect(provider.sendCalls).toBe(1);
  });

  it("SUPPORT D — malformed intents fail closed with zero dispatch", async () => {
    const { provider, adapter, intent } = makeWorld();

    const notAnObject = await adapter.bind(null as unknown as SendMessageIntent);
    expect(notExecutedShape(notAnObject, "MALFORMED_INTENT_NOT_AN_OBJECT")).toBe(true);

    const emptyMessageId = await adapter.bind({ ...intent, messageId: "  " });
    expect(notExecutedShape(emptyMessageId, "MALFORMED_INTENT_FIELDS")).toBe(true);

    const badAddress = await adapter.bind({ ...intent, to: "not-an-address" });
    expect(notExecutedShape(badAddress, "MALFORMED_INTENT_RECIPIENT_ADDRESS")).toBe(true);

    expect(provider.sendCalls).toBe(0);
    expect(provider.outbox.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // GC-08A — the GC-07R concurrent-duplicate counterexample, now a permanent
  // regression test: real Promise.all overlap, no artificial interleave.
  // -------------------------------------------------------------------------
  it("GC-08A C1 — simultaneous SAME-messageId executions: exactly ONE dispatch, honest loser, no retry", async () => {
    for (let iteration = 0; iteration < 12; iteration += 1) {
      const { provider, adapter, intent } = makeWorld();

      const [resultA, resultB] = await Promise.all([
        executeGuardianIntent(intent, adapter),
        executeGuardianIntent(intent, adapter),
      ]);

      // Exactly one execution may reach provider.send; the other dispatches nothing.
      expect(provider.sendCalls).toBe(1);
      expect(provider.outbox.length).toBe(1);
      expect(provider.outbox[0]?.messageId).toBe(intent.messageId);

      const outcomes = [resultA.outcome, resultB.outcome].sort();
      expect(outcomes).toEqual(["NOT_EXECUTED", "SUCCESS_PROVEN"]);

      const loser = resultA.outcome === "NOT_EXECUTED" ? resultA : resultB;
      if (loser.outcome !== "NOT_EXECUTED") throw new Error("unreachable");
      // Zero mutation of its own — proven (dispatched=false, NONE_PROVEN).
      expect(loser).toEqual({
        outcome: "NOT_EXECUTED",
        stage: "COMPATIBILITY",
        refusal: "BLOCKED",
        effect: { dispatched: false, state: "NONE_PROVEN" },
        reasons: ["SIMULTANEOUS_EXECUTION_FOR_SAME_MESSAGE_ID_IN_FLIGHT", intent.messageId],
      });
    }
  });

  it("GC-08A C2 — different messageIds in parallel: independent single-flight, NOT a global lock", async () => {
    const { provider, adapter } = makeWorld();
    const intentA: SendMessageIntent = {
      messageId: "msg-parallel-A",
      to: "alice@example.test",
      subject: "Statement A",
      body: "body A",
    };
    const intentB: SendMessageIntent = {
      messageId: "msg-parallel-B",
      to: "bob@example.test",
      subject: "Statement B",
      body: "body B",
    };

    const [resultA, resultB] = await Promise.all([
      executeGuardianIntent(intentA, adapter),
      executeGuardianIntent(intentB, adapter),
    ]);

    expect(resultA.outcome).toBe("SUCCESS_PROVEN");
    expect(resultB.outcome).toBe("SUCCESS_PROVEN");
    expect(provider.sendCalls).toBe(2);
    expect(provider.outbox.map((entry) => entry.messageId).sort()).toEqual([
      "msg-parallel-A",
      "msg-parallel-B",
    ]);
  });
});

function notExecutedShape(result: unknown, firstReason: string): boolean {
  if (typeof result !== "object" || result === null || "status" in result) return false;
  const r = result as GuardianResult;
  return (
    r.outcome === "NOT_EXECUTED" &&
    r.stage === "ELIGIBILITY" &&
    r.refusal === "BLOCKED" &&
    r.effect.dispatched === false &&
    r.effect.state === "NONE_PROVEN" &&
    r.reasons[0] === firstReason
  );
}
