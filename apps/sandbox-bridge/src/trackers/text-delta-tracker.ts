/**
 * Owns assistant text delta state and replay aliasing.
 */
export class TextDeltaTracker {
  readonly textEmittedLengths = new Map<string, number>();
  readonly trackedFullTextByKey = new Map<string, string>();
  readonly textAliases = new Map<string, string>();
  readonly responseTextByPartId = new Map<string, string>();
  readonly textPartMessageIds = new Map<string, string>();
  readonly textPartSegmentIds = new Map<string, number>();
  readonly messageRoles = new Map<string, "user" | "assistant">();
  currentTextSegmentId = 0;

  startNewTextSegment(): void {
    this.currentTextSegmentId++;
  }

  updateTextDelta(partId: string, fullText: string, messageId?: string | null): string | null {
    const canonicalPartId = this.resolveCanonicalTextPartId(partId, fullText);
    const isAliasedReplay = this.textAliases.has(partId);
    const prevText = this.responseTextByPartId.get(canonicalPartId);
    if (!prevText || fullText.length >= prevText.length) {
      this.responseTextByPartId.set(canonicalPartId, fullText);
    }
    if (!this.textPartSegmentIds.has(canonicalPartId)) {
      this.textPartSegmentIds.set(canonicalPartId, this.currentTextSegmentId);
    }
    if (messageId) {
      this.textPartMessageIds.set(canonicalPartId, messageId);
    }
    const trackingKey = `text-${canonicalPartId}`;
    const previousFullText = this.trackedFullTextByKey.get(trackingKey);
    if (isAliasedReplay && previousFullText !== undefined && !fullText.startsWith(previousFullText)) {
      return null;
    }
    return this.updateTrackedDelta(trackingKey, fullText);
  }

  updateTrackedDelta(key: string, fullText: string): string | null {
    const prevLen = this.textEmittedLengths.get(key) ?? 0;
    const previousFullText = this.trackedFullTextByKey.get(key);
    const cursor = previousFullText !== undefined && !fullText.startsWith(previousFullText) ? 0 : prevLen;
    const delta = fullText.slice(cursor);
    if (delta) {
      this.textEmittedLengths.set(key, fullText.length);
      this.trackedFullTextByKey.set(key, fullText);
      return delta;
    }
    if (previousFullText === undefined || fullText !== previousFullText) {
      this.textEmittedLengths.set(key, fullText.length);
      this.trackedFullTextByKey.set(key, fullText);
    }
    return null;
  }

  latestResponseText(): string {
    let latest = "";
    for (const text of this.responseTextByPartId.values()) {
      latest = text;
    }
    return latest.trim();
  }

  latestMessageResponseText(): string {
    let latestPartId: string | null = null;
    for (const partId of this.responseTextByPartId.keys()) {
      latestPartId = partId;
    }
    if (!latestPartId) return "";

    const latestMessageId = this.textPartMessageIds.get(latestPartId);
    const latestSegmentId = this.textPartSegmentIds.get(latestPartId);
    if (latestSegmentId === undefined) return this.latestResponseText();

    const textParts: string[] = [];
    for (const [partId, text] of this.responseTextByPartId) {
      if (this.textPartSegmentIds.get(partId) !== latestSegmentId) continue;
      const partMessageId = this.textPartMessageIds.get(partId);
      if (latestMessageId ? partMessageId === latestMessageId : !partMessageId) {
        textParts.push(text);
      }
    }
    return (textParts.length > 0 ? textParts.join("\n\n") : (this.responseTextByPartId.get(latestPartId) ?? "")).trim();
  }

  private resolveCanonicalTextPartId(partId: string, fullText: string): string {
    const alias = this.textAliases.get(partId);
    if (alias) return alias;
    if (this.responseTextByPartId.has(partId)) return partId;

    for (const [existingPartId, existingText] of this.responseTextByPartId) {
      if (existingPartId !== partId && existingText === fullText) {
        this.textAliases.set(partId, existingPartId);
        return existingPartId;
      }
    }

    return partId;
  }

  recordMessageRole(messageID: string | null | undefined, role: "user" | "assistant"): void {
    if (!messageID) return;
    this.messageRoles.set(messageID, role);
  }

  getMessageRole(messageID: string | null | undefined): "user" | "assistant" | undefined {
    if (!messageID) return undefined;
    return this.messageRoles.get(messageID);
  }
}
