/**
 * GC-06 blind fourth-domain proof — OUTBOUND EMAIL (sendMessage) adapter.
 *
 * Derived ONLY from Guardian Core v0.1 (src/guardianCore.ts + README.md),
 * blind to all other domains and adapters. Domain mapping:
 *
 *  - intent          : data-only declaration of ONE message to send. No
 *                      credential, no transport, no provider URL, no raw
 *                      provider payload — structurally inexpressible.
 *  - authority       : operator-closed. The provider and the recipient
 *                      allowlist live inside this adapter (constructed by the
 *                      operator); the guardian caller can never supply them.
 *  - eligibility     : fail-closed bind — well-formed intent, recipient inside
 *                      the operator scope, messageId not already sent,
 *                      observation machinery reachable. Any refusal or
 *                      undecidable question terminates with zero dispatch.
 *  - relevant state  : the provider outbox — "has this messageId already been
 *                      sent?". No fingerprint/SHA/CAS/snapshot hash exists
 *                      naturally in this domain; none is invented.
 *  - bound proposal  : frozen decision + the observation it is bound to,
 *                      opaque to the Core, consumed only by apply.
 *  - compatibility   : apply re-proves the bind-time observation against the
 *                      CURRENT outbox (semantic precondition: "this message
 *                      has not already been sent") and refuses with zero
 *                      mutation on mismatch — stale decisions die naturally.
 *  - effect boundary : exactly ONE provider.send call. Nothing else mutates.
 *  - concurrency     : SAME-INSTANCE single-flight keyed by messageId — two
 *                      simultaneous executions of the SAME message cannot both
 *                      dispatch (GC-07R fix). Cross-process coordination is
 *                      NOT provided (see apply + README).
 *  - postcondition   : the message is durably registered in the provider
 *                      outbox, proven by an independent post-read. Provider
 *                      acceptance alone is never proof.
 *  - evidence        : the outbox entry itself (providerId, queuedAt, content).
 *  - indeterminate   : acceptance without registration proof, unavailable
 *                      postcondition reads, transport timeout after possible
 *                      dispatch — reported honestly, never promoted to success.
 */

import {
  type BindNotExecuted,
  type BindOutcome,
  type DomainAdapter,
  type GuardianResult,
} from "../../memoryos-guardian-core/src/guardianCore";
import {
  FakeEmailProvider,
  ProviderRejectedError,
  type OutboxMessage,
  type SendReceipt,
} from "./emailProvider";

/** Data-only intent. NO credential, NO transport, NO provider URL, NO raw payload. */
export interface SendMessageIntent {
  readonly messageId: string;
  readonly to: string;
  readonly subject: string;
  readonly body: string;
}

/** The only keys a sendMessage intent may carry. Anything else is refused. */
const INTENT_KEYS: ReadonlySet<string> = new Set(["messageId", "to", "subject", "body"]);

/** The observation a sendMessage decision is bound to. */
export interface BoundObservation {
  readonly messageIdAbsentFromOutbox: true;
  readonly observedAt: string;
}

/** Opaque to the Core. Forged by bind, consumed only by apply. */
export interface SendMessageProposal {
  readonly kind: "sendMessage.v1/proposal";
  readonly messageId: string;
  readonly message: { readonly to: string; readonly subject: string; readonly body: string };
  readonly observation: BoundObservation;
}

/**
 * Operator-side configuration. This is the adapter's CLOSED power: it is given
 * to the operator at construction time and never appears on the guardian call
 * surface, which stays exactly (intent, adapter).
 */
export interface EmailAdapterOperatorConfig {
  readonly provider: FakeEmailProvider;
  /** The only recipients this adapter may ever dispatch to. */
  readonly allowedRecipients: readonly string[];
  readonly sendTimeoutMs?: number;
  readonly now?: () => string;
}

const DEFAULT_SEND_TIMEOUT_MS = 250;
const MAX_FIELD_LENGTH = 2000;
const ADDRESS_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function notExecuted(
  stage: "ELIGIBILITY" | "OBSERVATION" | "COMPATIBILITY",
  refusal: "BLOCKED" | "UNDETERMINED",
  reasons: string[],
): BindNotExecuted {
  return {
    outcome: "NOT_EXECUTED",
    stage,
    refusal,
    effect: { dispatched: false, state: "NONE_PROVEN" },
    reasons,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Build the operator-owned adapter. Power (provider, allowlist, timeout) is
 * closed HERE — the returned object exposes only the two Core operations.
 */
export function createEmailGuardianAdapter(
  config: EmailAdapterOperatorConfig,
): DomainAdapter<SendMessageIntent, SendMessageProposal> {
  const provider = config.provider;
  const allowedRecipients = new Set(config.allowedRecipients.map((address) => address.trim().toLowerCase()));
  const now = config.now ?? (() => new Date().toISOString());
  const sendTimeoutMs = config.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;

  /** Per-messageId single-flight reservation — SAME adapter instance ONLY (see apply). */
  const inFlightMessageIds = new Set<string>();

  /** Bounded wait around the single transport call — the adapter's own machinery. */
  function withTimeout<T>(pending: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("PROVIDER_SEND_TIMEOUT")), sendTimeoutMs);
      pending.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  return {
    // ---------------------------------------------------------------------------
    // bind — READ-ONLY. Fail-closed eligibility + observation. Never sends.
    // ---------------------------------------------------------------------------
    async bind(rawIntent: SendMessageIntent): Promise<BindOutcome<SendMessageProposal>> {
      // (0) Structural authority edge: only a plain, well-formed intent is admissible.
      if (!isPlainObject(rawIntent)) {
        return notExecuted("ELIGIBILITY", "BLOCKED", ["MALFORMED_INTENT_NOT_AN_OBJECT"]);
      }
      const forbiddenKeys = Object.keys(rawIntent).filter((key) => !INTENT_KEYS.has(key));
      if (forbiddenKeys.length > 0) {
        // An intent carrying machinery (credentials, transport, URLs, raw payloads)
        // is not a sendMessage intent — refuse before anything else happens.
        return notExecuted("ELIGIBILITY", "BLOCKED", ["INTENT_CARRIES_FORBIDDEN_AUTHORITY", ...forbiddenKeys]);
      }
      const { messageId, to, subject, body } = rawIntent;
      if (
        typeof messageId !== "string" ||
        messageId.trim() === "" ||
        typeof to !== "string" ||
        typeof subject !== "string" ||
        typeof body !== "string"
      ) {
        return notExecuted("ELIGIBILITY", "BLOCKED", ["MALFORMED_INTENT_FIELDS"]);
      }
      const recipient = to.trim().toLowerCase();
      if (!ADDRESS_PATTERN.test(recipient)) {
        return notExecuted("ELIGIBILITY", "BLOCKED", ["MALFORMED_INTENT_RECIPIENT_ADDRESS"]);
      }
      if (subject.length > MAX_FIELD_LENGTH || body.length > MAX_FIELD_LENGTH) {
        return notExecuted("ELIGIBILITY", "BLOCKED", ["INTENT_FIELD_TOO_LARGE"]);
      }

      // (1) Authority: the recipient must be inside the operator-closed scope.
      if (!allowedRecipients.has(recipient)) {
        return notExecuted("ELIGIBILITY", "BLOCKED", ["RECIPIENT_NOT_IN_ALLOWED_SCOPE", recipient]);
      }

      // (2) Observation (read-only): has this message already been sent?
      let existing: OutboxMessage | undefined;
      try {
        existing = await provider.findMessage(messageId);
      } catch (error) {
        return notExecuted("OBSERVATION", "UNDETERMINED", ["OUTBOX_OBSERVATION_UNAVAILABLE", errorReason(error)]);
      }
      if (existing !== undefined) {
        return notExecuted("ELIGIBILITY", "BLOCKED", ["MESSAGE_ID_ALREADY_SENT"]);
      }

      // (3) Forge the bound proposal: the decision AND the observation it is bound to.
      const proposal: SendMessageProposal = Object.freeze({
        kind: "sendMessage.v1/proposal",
        messageId,
        message: Object.freeze({ to: recipient, subject, body }),
        observation: Object.freeze({ messageIdAbsentFromOutbox: true, observedAt: now() }),
      });
      return { status: "BOUND", proposal };
    },

    // ---------------------------------------------------------------------------
    // apply — the ONLY potentially mutating boundary. Exactly one provider.send.
    // ---------------------------------------------------------------------------
    async apply(proposal: SendMessageProposal): Promise<GuardianResult> {
      // GC-07R fix — SAME-INSTANCE single-flight keyed by messageId. The
      // re-prove → send sequence is not atomic with the provider's outbox
      // registration, so two simultaneous executions of the SAME messageId
      // could both pass revalidation and both dispatch. The check + add below
      // are synchronous (no await between) — atomic within this adapter
      // instance. Different messageIds never contend; there is NO global lock.
      // Scope: this instance only — no cross-process/machine coordination, no
      // exactly-once, and a LATER run after an ambiguous outcome (e.g. timeout)
      // may still dispatch. Provider-native idempotency remains preferable.
      if (inFlightMessageIds.has(proposal.messageId)) {
        // Honest loser: this run dispatches nothing — proven (its apply never
        // invokes provider.send). It reports only what it can prove about its
        // OWN attempt, never the other execution's success.
        return {
          outcome: "NOT_EXECUTED",
          stage: "COMPATIBILITY",
          refusal: "BLOCKED",
          effect: { dispatched: false, state: "NONE_PROVEN" },
          reasons: ["SIMULTANEOUS_EXECUTION_FOR_SAME_MESSAGE_ID_IN_FLIGHT", proposal.messageId],
        };
      }
      inFlightMessageIds.add(proposal.messageId);
      try {
        return await applyGuarded(proposal);
      } finally {
        inFlightMessageIds.delete(proposal.messageId);
      }
    },
  };

  async function applyGuarded(proposal: SendMessageProposal): Promise<GuardianResult> {
      // STATE-BOUND EXECUTION: re-prove the bind-time observation against the
      // CURRENT outbox before dispatching anything.
      let current: OutboxMessage | undefined;
      try {
        current = await provider.findMessage(proposal.messageId);
      } catch (error) {
        // Cannot re-prove "not already sent" -> sending could duplicate -> fail closed.
        return {
          outcome: "NOT_EXECUTED",
          stage: "COMPATIBILITY",
          refusal: "BLOCKED",
          effect: { dispatched: true, state: "NONE_PROVEN" },
          reasons: ["COMPATIBILITY_REPROOF_UNAVAILABLE", errorReason(error)],
        };
      }
      if (current !== undefined) {
        // The relevant state changed after bind (message already sent concurrently):
        // the stale decision is refused with ZERO dispatch — proven (send never invoked).
        return {
          outcome: "NOT_EXECUTED",
          stage: "COMPATIBILITY",
          refusal: "BLOCKED",
          effect: { dispatched: true, state: "NONE_PROVEN" },
          reasons: ["BINDING_INVALIDATED", "MESSAGE_ID_ALREADY_PRESENT_IN_OUTBOX"],
        };
      }

      // The single controlled effect. One call site; nothing retries it.
      let receipt: SendReceipt;
      try {
        receipt = await withTimeout(
          provider.send({
            messageId: proposal.messageId,
            to: proposal.message.to,
            subject: proposal.message.subject,
            body: proposal.message.body,
          }),
        );
      } catch (error) {
        if (error instanceof ProviderRejectedError) {
          // Definitive, authoritative refusal by the provider. Corroborate with
          // an independent read, then adjudicate honestly.
          let postRead: "absent" | "present" | "unavailable";
          try {
            postRead = (await provider.findMessage(proposal.messageId)) === undefined ? "absent" : "present";
          } catch {
            postRead = "unavailable";
          }
          if (postRead === "present") {
            return {
              outcome: "INDETERMINATE",
              effect: { dispatched: true, state: "UNDETERMINED" },
              reasons: ["CONFLICTING_EVIDENCE_REJECTED_BUT_PRESENT"],
            };
          }
          return {
            outcome: "FAILURE_PROVEN",
            effect: { dispatched: true, state: "NONE_PROVEN" },
            evidence: { kind: "provider-rejection", rejection: error.rejection, outboxPostRead: postRead },
            reasons: ["PROVIDER_REJECTED_DELIVERY", error.rejection],
          };
        }
        // Timeout or transport failure AFTER the boundary was reached: occurrence
        // unknowable. Propagate — the Core reports INDETERMINATE (never retried).
        throw error;
      }

      // Postcondition: durably registered in the outbox, proven by an INDEPENDENT
      // read (acceptance alone is never sufficient proof).
      let entry: OutboxMessage | undefined;
      try {
        entry = await provider.findMessage(proposal.messageId);
      } catch (error) {
        return {
          outcome: "INDETERMINATE",
          effect: { dispatched: true, state: "UNDETERMINED" },
          reasons: ["POSTCONDITION_OBSERVATION_UNAVAILABLE", errorReason(error)],
        };
      }
      const matches =
        entry !== undefined &&
        entry.providerId === receipt.providerId &&
        entry.to === proposal.message.to &&
        entry.subject === proposal.message.subject &&
        entry.body === proposal.message.body;
      if (matches && entry) {
        return {
          outcome: "SUCCESS_PROVEN",
          effect: { dispatched: true, state: "OCCURRED" },
          evidence: {
            kind: "outbox-post-read",
            messageId: entry.messageId,
            providerId: entry.providerId,
            queuedAt: entry.queuedAt,
            recipient: entry.to,
          },
        };
      }
      // Acceptance without sufficient registration proof: never SUCCESS_PROVEN.
      return {
        outcome: "INDETERMINATE",
        effect: { dispatched: true, state: "UNDETERMINED" },
        reasons: ["ACCEPTED_WITHOUT_SUFFICIENT_REGISTRATION_PROOF"],
      };
  }
}
