/**
 * Scheduled triggers SDK: `client.schedules.*`. A schedule runs a function on a cron timetable.
 *
 * Wire mapping (project plane):
 *   - `list({ status?, functionName?, limit?, cursor? })` -> GET    /@<slug>/forge/schedules   (`functionName` is sent as `function_name`)
 *   - `get(id)`                                           -> GET    /@<slug>/forge/schedules/<id>
 *   - `create({...})`                                     -> POST   /@<slug>/forge/schedules
 *   - `update(id, {...})`                                 -> PATCH  /@<slug>/forge/schedules/<id>
 *   - `delete(id)`                                        -> DELETE /@<slug>/forge/schedules/<id>        (204, no body)
 *   - `runs(id, { limit?, cursor? })`                     -> GET    /@<slug>/forge/schedules/<id>/runs
 *   - `runNow(id)`                                        -> POST   /@<slug>/forge/schedules/<id>/run-now  (202)
 *
 * Lists are cursor-paginated, newest first: pass `meta.cursor.next` of one page as `cursor` of the next, until it is null.
 *
 * A schedule interval under 5 minutes is rejected with 400 K9O_INVALID_FIELD_VALUE (field schedule_expression), on every plan.
 */

import { request, type HttpClientConfig } from "./http.ts";
import { KError } from "./kerror.ts";
import { projectPath } from "./url-grammar.ts";
import type { Envelope, PaginatedEnvelope } from "./envelope.ts";

/** What happens to runs missed while the schedule was paused or the platform was down. */
export type CatchupPolicy = "skip" | "run_once" | "run_all";
export type ScheduleStatus = "active" | "paused";

export type Schedule = {
  /** UUID. */
  id: string;
  functionName: string;
  /** Five-field cron. An alias such as `@daily` is stored and returned expanded. */
  scheduleExpression: string;
  scheduleTimezone: string;
  catchupPolicy: CatchupPolicy;
  collection: string | null;
  enabled: boolean;
  /** `active` when `enabled`, otherwise `paused`. */
  status: ScheduleStatus;
  logOkInvocations: boolean;
  createdAt: string;
  lastInvocationAt: string | null;
  nextInvocationAt: string | null;
};

/** One run of a schedule. */
export type ScheduleRun = {
  id: string;
  triggerId: string;
  functionName: string;
  collection: string | null;
  event: string;
  status: string;
  attemptCount: number;
  errorDetail: string | null;
  errorOutput: string | null;
  recordId: string | null;
  triggeredAt: string;
  completedAt: string | null;
};

export type ListSchedulesOptions = {
  status?: ScheduleStatus | undefined;
  /** Only the schedules of this function. */
  functionName?: string | undefined;
  /** 1 to 200; the gateway defaults to 50. */
  limit?: number | undefined;
  /** `meta.cursor.next` of the previous page. */
  cursor?: string | undefined;
};

export type ListScheduleRunsOptions = {
  /** 1 to 200. */
  limit?: number | undefined;
  cursor?: string | undefined;
};

export type CreateScheduleInput = {
  /** An existing function that is not retired. */
  functionName: string;
  /** Five-field cron (minute 0-59, hour 0-23, day 1-31, month 1-12, weekday 0-6) or `@yearly`, `@annually`, `@monthly`, `@weekly`, `@daily`, `@midnight`, `@hourly`. */
  scheduleExpression: string;
  /** `UTC` (default) or `Region/City`. */
  scheduleTimezone?: string | undefined;
  /** Default `skip`. `run_all` is available on every plan. */
  catchupPolicy?: CatchupPolicy | undefined;
  /** An existing collection, passed to the function with each run. */
  collection?: string | undefined;
  /** Default `true`. */
  enabled?: boolean | undefined;
  /** Record successful runs too (default `false`). */
  logOkInvocations?: boolean | undefined;
};

/** Fields to change; at least one. The function cannot be changed. */
export type UpdateScheduleInput = {
  scheduleExpression?: string | undefined;
  scheduleTimezone?: string | undefined;
  catchupPolicy?: CatchupPolicy | undefined;
  status?: ScheduleStatus | undefined;
  enabled?: boolean | undefined;
  logOkInvocations?: boolean | undefined;
};

function invalid(message: string, context: Record<string, unknown> = {}): KError {
  return new KError({ code: "K9O_INVALID_FIELD_VALUE", message, context, recommendation: null });
}

function checkLimit(limit: unknown): void {
  if (limit !== undefined && (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 200)) {
    throw invalid("limit must be a whole number from 1 to 200", { limit });
  }
}

function requireId(id: unknown): string {
  if (typeof id !== "string" || id.length === 0) throw invalid("schedule id must be a non-empty string");
  return id;
}

export function makeSchedulesNamespace(config: HttpClientConfig) {
  const path = (tail: string): string => {
    if (typeof config.projectSlug !== "string" || config.projectSlug.length === 0) {
      throw new Error("schedules operations require projectSlug bound on the client");
    }
    return projectPath(config.projectSlug, `forge/schedules${tail}`);
  };
  const one = (id: string, tail = ""): string => path(`/${encodeURIComponent(requireId(id))}${tail}`);
  return {
    /** List schedules, newest first, one page at a time. */
    async list(opts: ListSchedulesOptions = {}): Promise<PaginatedEnvelope<ReadonlyArray<Schedule>>> {
      checkLimit(opts.limit);
      return (await request(config, {
        method: "GET",
        path: path(""),
        query: { status: opts.status, function_name: opts.functionName, limit: opts.limit, cursor: opts.cursor },
      })) as PaginatedEnvelope<ReadonlyArray<Schedule>>;
    },

    async get(id: string): Promise<Envelope<Schedule>> {
      return request(config, { method: "GET", path: one(id) });
    },

    /** Create a schedule. Answers 201 with the schedule. */
    async create(input: CreateScheduleInput): Promise<Envelope<Schedule>> {
      if (input === null || typeof input !== "object") throw invalid("input must be an object");
      return request(config, { method: "POST", path: path(""), body: input });
    },

    /** Change a schedule. Send at least one field; `status: "paused"` stops it, `"active"` resumes it. */
    async update(id: string, patch: UpdateScheduleInput): Promise<Envelope<Schedule>> {
      if (patch === null || typeof patch !== "object") throw invalid("patch must be an object");
      const keys = ["scheduleExpression", "scheduleTimezone", "catchupPolicy", "status", "enabled", "logOkInvocations"] as const;
      if (!keys.some((k) => patch[k] !== undefined)) throw invalid(`patch needs at least one of: ${keys.join(", ")}`);
      return request(config, { method: "PATCH", path: one(id), body: patch });
    },

    /** Delete a schedule. Answers 204 with no body, so `data` is `undefined`. */
    async delete(id: string): Promise<Envelope<void>> {
      return request(config, { method: "DELETE", path: one(id) });
    },

    /** The schedule's runs, newest first, one page at a time. */
    async runs(id: string, opts: ListScheduleRunsOptions = {}): Promise<PaginatedEnvelope<ReadonlyArray<ScheduleRun>>> {
      checkLimit(opts.limit);
      return (await request(config, { method: "GET", path: one(id, "/runs"), query: { limit: opts.limit, cursor: opts.cursor } })) as PaginatedEnvelope<ReadonlyArray<ScheduleRun>>;
    },

    /** Start one run now, outside the timetable. Answers 202; the body is returned as the gateway sent it. */
    async runNow(id: string): Promise<Envelope<unknown>> {
      return request(config, { method: "POST", path: one(id, "/run-now") });
    },
  };
}
