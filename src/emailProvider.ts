/**
 * GC-06 blind fourth-domain proof — deterministic fake OUTBOUND EMAIL provider.
 *
 * SCOPE: NO Gmail, NO SMTP, NO network, NO real sending. This is the
 * operator-owned domain machinery: a fully deterministic in-process fake whose
 * ONLY mutating primitive is `send` (accept-or-reject one message into an
 * outbox) and whose read primitive is `findMessage` (lookup by messageId).
 *
 * Derivation is from Guardian Core alone: the provider is the domain's
 * machinery — the thing that could actually perform the declared effect — and
 * is closed inside the operator-built adapter, never accepted from the caller.
 */

/** A message durably registered in the provider outbox (the domain's proof object). */
export interface OutboxMessage {
  readonly messageId: string;
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  readonly providerId: string;
  readonly queuedAt: string;
}

/** Provider acceptance receipt. Acceptance alone is NOT proof of registration. */
export interface SendReceipt {
  readonly accepted: true;
  readonly providerId: string;
  readonly queuedAt: string;
}

/**
 * Deterministic provider behavior, chosen by the TEST (never by the guardian
 * caller). Modes model the honest adversarial space of an email backend:
 *  - accept          : accepts AND durably registers the message.
 *  - accept-and-drop : hands back an acceptance receipt but silently loses the
 *                      message (never registers it) — acceptance without proof.
 *  - reject          : definitive synchronous refusal (authoritative result).
 *  - hang            : never settles — transport timeout after possible dispatch.
 */
export type ProviderScript =
  | { mode: "accept" }
  | { mode: "accept-and-drop" }
  | { mode: "reject"; reason: string }
  | { mode: "hang" };

export class ProviderRejectedError extends Error {
  constructor(readonly rejection: string) {
    super(`PROVIDER_REJECTED: ${rejection}`);
    this.name = "ProviderRejectedError";
  }
}

export class FakeEmailProvider {
  readonly outbox: OutboxMessage[] = [];
  sendCalls = 0;
  readCalls = 0;
  private readFailure = false;
  private failReadsFromSendCount: number | null = null;

  private readonly script: ProviderScript;
  private readonly now: () => string;

  constructor(script: ProviderScript = { mode: "accept" }, now: () => string = () => "2026-01-01T00:00:00.000Z") {
    this.script = script;
    this.now = now;
  }

  /** Make every outbox read throw (observation machinery unavailable). */
  failReads(): void {
    this.readFailure = true;
  }

  /** Make outbox reads throw once `send` has been called >= n times. */
  failReadsFromSend(n: number): void {
    this.failReadsFromSendCount = n;
  }

  /**
   * The ONLY provider-side mutating primitive. One call == at most one message
   * dispatched toward the (fake) transport. Never called by bind.
   */
  async send(message: { messageId: string; to: string; subject: string; body: string }): Promise<SendReceipt> {
    this.sendCalls += 1;
    const script = this.script;
    if (script.mode === "hang") {
      return new Promise<SendReceipt>(() => undefined); // never settles
    }
    if (script.mode === "reject") {
      throw new ProviderRejectedError(script.reason);
    }
    const receipt: SendReceipt = {
      accepted: true,
      providerId: `prov-${message.messageId}`,
      queuedAt: this.now(),
    };
    if (script.mode === "accept") {
      // Durable registration — the fact an independent post-read can later prove.
      this.outbox.push({ ...message, providerId: receipt.providerId, queuedAt: receipt.queuedAt });
    }
    // accept-and-drop: receipt returned, message silently lost (never registered).
    return receipt;
  }

  /** Read-only observation primitive: deterministic lookup by messageId. */
  async findMessage(messageId: string): Promise<OutboxMessage | undefined> {
    this.readCalls += 1;
    if (this.readFailure) throw new Error("OUTBOX_READ_UNAVAILABLE");
    if (this.failReadsFromSendCount !== null && this.sendCalls >= this.failReadsFromSendCount) {
      throw new Error("OUTBOX_READ_UNAVAILABLE");
    }
    return this.outbox.find((entry) => entry.messageId === messageId);
  }

  /** Test hook: ANOTHER actor sends the SAME messageId concurrently (bypasses the adapter). */
  async injectConcurrentSend(message: { messageId: string; to: string; subject: string; body: string }): Promise<void> {
    this.outbox.push({ ...message, providerId: `prov-${message.messageId}`, queuedAt: this.now() });
  }
}
