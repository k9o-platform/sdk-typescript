/**
 * Custody status: `client.custody.status()`.
 *
 * Wire mapping (project plane):
 *   - `custody.status()` -> GET /@<slug>/custody/status
 *
 * Read-only. Needs the project-admin or project-auditor role. Changing custody is a Console action.
 */

import { request, type HttpClientConfig } from "./http.ts";
import { projectPath } from "./url-grammar.ts";
import type { Envelope } from "./envelope.ts";

/** The latest custody job of the project. */
export type CustodyJob = {
  kind: "transition" | "external_transition";
  status: "pending" | "running" | "completed" | "failed";
  /** ISO 8601 timestamp, or `null` while the job has not finished. */
  completedAt: string | null;
};

/** Details of the hardware security module that holds the project's keys. */
export type CustodyHsm = {
  vendor: "thales-luna" | "entrust-nshield" | "aws-cloudhsm" | null;
  clusterId: string;
  region: string;
  attestation: {
    /** `null` until the gateway reports attestation. */
    status: string | null;
    /** `null` until the gateway reports attestation. */
    verifiedAt: string | null;
  };
  /** `null` until the gateway lists keys. */
  keys: ReadonlyArray<Record<string, unknown>> | null;
};

export type CustodyStatus = {
  /** For example `PLATFORM_MANAGED`. An open set: treat it as a string. */
  mode: string;
  /** True when an external key source is attached to the project. */
  attached: boolean;
  provider: "platform" | "external_kms" | "hsm" | null;
  /** `null` when no custody job has run. */
  lastJob: CustodyJob | null;
  /** Present (not `null`) only when `provider` is `"hsm"`. A missing `hsm` in the answer reads as `null`. */
  hsm: CustodyHsm | null;
};

export function makeCustodyNamespace(config: HttpClientConfig) {
  return {
    /**
     * The project's key custody: mode, whether an external source is attached, its provider and the last job.
     * Errors: 403 (other role), 404 (not a project member), 502 `K9O_UPSTREAM_UNAVAILABLE` (the key manager cannot answer).
     */
    async status(): Promise<Envelope<CustodyStatus>> {
      if (typeof config.projectSlug !== "string" || config.projectSlug.length === 0) {
        throw new Error("custody operations require projectSlug bound on the client");
      }
      const res = await request<Partial<CustodyStatus> & Omit<CustodyStatus, "hsm">>(config, {
        method: "GET",
        path: projectPath(config.projectSlug, "custody/status"),
      });
      return { ...res, data: { ...res.data, hsm: res.data.hsm ?? null } } as Envelope<CustodyStatus>;
    },
  };
}
