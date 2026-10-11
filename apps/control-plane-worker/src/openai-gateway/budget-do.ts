import { DurableObject } from "cloudflare:workers";

import type { Env } from "../types";
import { jsonErrorResponse, jsonResponse, parseJsonBody } from "../utils";

type BudgetState = {
  month: string;
  spentUsdMicros: number;
  reservedUsdMicros: number;
};

type ReserveRequest = {
  estimateUsdMicros: number;
  monthlyLimitUsdMicros: number;
  now?: number;
};

type SettleRequest = {
  ledgerId?: string;
  reservedUsdMicros: number;
  actualUsdMicros: number;
  month?: string;
  now?: number;
};

type ReleaseRequest = {
  ledgerId?: string;
  reservedUsdMicros: number;
  month?: string;
  now?: number;
};

const STORAGE_KEY = "budget";

function monthKey(now: number): string {
  return new Date(now).toISOString().slice(0, 7);
}

function requestMonth(value: unknown, now: number): string {
  return typeof value === "string" && /^\d{4}-\d{2}$/.test(value) ? value : monthKey(now);
}

function storageKeyForMonth(month: string): string {
  return `${STORAGE_KEY}:${month}`;
}

function settlementKeyForLedger(month: string, ledgerId: string): string {
  return `${STORAGE_KEY}:settled:${month}:${ledgerId}`;
}

function releaseKeyForLedger(month: string, ledgerId: string): string {
  return `${STORAGE_KEY}:released:${month}:${ledgerId}`;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

export class OpenAIGatewayBudgetDO extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/budget/reserve") {
      return this.reserve(request);
    }
    if (request.method === "POST" && url.pathname === "/budget/settle") {
      return this.settle(request);
    }
    if (request.method === "POST" && url.pathname === "/budget/release") {
      return this.release(request);
    }
    if (request.method === "GET" && url.pathname === "/budget/state") {
      const now = Date.now();
      return jsonResponse({ ok: true, state: await this.getStateForMonth(now) });
    }
    return jsonErrorResponse("Not found", 404);
  }

  private async reserve(request: Request): Promise<Response> {
    const body = (await parseJsonBody(request)) as ReserveRequest | null;
    const estimateUsdMicros = nonNegativeInteger(body?.estimateUsdMicros);
    const monthlyLimitUsdMicros = nonNegativeInteger(body?.monthlyLimitUsdMicros);
    if (estimateUsdMicros === null || monthlyLimitUsdMicros === null) {
      return jsonErrorResponse("Invalid budget reservation request", 400);
    }
    const now = nonNegativeInteger(body?.now) ?? Date.now();

    return this.ctx.storage.transaction(async () => {
      const state = await this.getStateForMonth(now);
      if (state.spentUsdMicros + state.reservedUsdMicros + estimateUsdMicros > monthlyLimitUsdMicros) {
        return jsonResponse(
          {
            ok: false,
            error: "Cycloid OpenAI budget exhausted",
            code: "cycloid_openai_budget_exhausted",
            state,
          },
          429,
        );
      }

      state.reservedUsdMicros += estimateUsdMicros;
      await this.putState(state);
      return jsonResponse({ ok: true, reservedUsdMicros: estimateUsdMicros, month: state.month, state });
    });
  }

  private async settle(request: Request): Promise<Response> {
    const body = (await parseJsonBody(request)) as SettleRequest | null;
    const reservedUsdMicros = nonNegativeInteger(body?.reservedUsdMicros);
    const actualUsdMicros = nonNegativeInteger(body?.actualUsdMicros);
    if (reservedUsdMicros === null || actualUsdMicros === null) {
      return jsonErrorResponse("Invalid budget settlement request", 400);
    }
    const now = nonNegativeInteger(body?.now) ?? Date.now();
    const month = requestMonth(body?.month, now);
    const ledgerId = typeof body?.ledgerId === "string" && body.ledgerId.length > 0 ? body.ledgerId : null;

    return this.ctx.storage.transaction(async () => {
      if (ledgerId && (await this.ctx.storage.get(settlementKeyForLedger(month, ledgerId)))) {
        return jsonResponse({ ok: true, duplicate: true, state: await this.getStateForMonthKey(month) });
      }
      const state = await this.getStateForMonthKey(month);
      // Free the reservation exactly once across settle/release: if a prior release
      // already freed it for this ledger, only record spend here.
      const alreadyReleased = ledgerId
        ? Boolean(await this.ctx.storage.get(releaseKeyForLedger(month, ledgerId)))
        : false;
      if (!alreadyReleased) {
        state.reservedUsdMicros = Math.max(0, state.reservedUsdMicros - reservedUsdMicros);
      }
      state.spentUsdMicros += actualUsdMicros;
      await this.putState(state);
      if (ledgerId) await this.ctx.storage.put(settlementKeyForLedger(month, ledgerId), true);
      return jsonResponse({ ok: true, state });
    });
  }

  private async release(request: Request): Promise<Response> {
    const body = (await parseJsonBody(request)) as ReleaseRequest | null;
    const reservedUsdMicros = nonNegativeInteger(body?.reservedUsdMicros);
    if (reservedUsdMicros === null) return jsonErrorResponse("Invalid budget release request", 400);
    const now = nonNegativeInteger(body?.now) ?? Date.now();
    const month = requestMonth(body?.month, now);
    const ledgerId = typeof body?.ledgerId === "string" && body.ledgerId.length > 0 ? body.ledgerId : null;

    return this.ctx.storage.transaction(async () => {
      if (ledgerId && (await this.ctx.storage.get(releaseKeyForLedger(month, ledgerId)))) {
        return jsonResponse({ ok: true, duplicate: true, state: await this.getStateForMonthKey(month) });
      }
      const state = await this.getStateForMonthKey(month);
      // Free the reservation exactly once across settle/release: if a prior settle
      // already freed it for this ledger, skip the subtraction.
      const alreadySettled = ledgerId
        ? Boolean(await this.ctx.storage.get(settlementKeyForLedger(month, ledgerId)))
        : false;
      if (!alreadySettled) {
        state.reservedUsdMicros = Math.max(0, state.reservedUsdMicros - reservedUsdMicros);
      }
      await this.putState(state);
      if (ledgerId) await this.ctx.storage.put(releaseKeyForLedger(month, ledgerId), true);
      return jsonResponse({ ok: true, state });
    });
  }

  private async getStateForMonth(now: number): Promise<BudgetState> {
    return this.getStateForMonthKey(monthKey(now));
  }

  private async getStateForMonthKey(month: string): Promise<BudgetState> {
    const stored = await this.ctx.storage.get<BudgetState>(storageKeyForMonth(month));
    if (!stored || stored.month !== month) {
      return { month, spentUsdMicros: 0, reservedUsdMicros: 0 };
    }
    return stored;
  }

  private async putState(state: BudgetState): Promise<void> {
    await this.ctx.storage.put(storageKeyForMonth(state.month), state);
  }
}
