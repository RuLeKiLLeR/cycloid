/**
 * Session event types shared between control-plane-worker and UI.
 *
 * Both apps import from this file -- never define these types locally.
 */

/** A durable event as stored and broadcast by the DO. */
export interface DurableSessionEvent {
  type: string;
  sequence: number;
  data: Record<string, unknown>;
}
