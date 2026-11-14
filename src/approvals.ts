/**
 * Approvals SDK: `client.approvals.*` (the pending-change queue) and `client.approvalPolicies.*` (the rules that decide
 * which writes are queued).
 *
 * Wire mapping (project plane):
 *   - `approvals.list({ status?, limit?, cursor? })` -> GET    /@<slug>/pending-approvals
 *   - `approvals.get(id)`                            -> GET    /@<slug>/pending-approvals/<id>
 *   - `approvals.approve(id, { reason? })`           -> POST   /@<slug>/pending-approvals/<id>/approve
 *   - `approvals.reject(id, { reason })`             -> POST   /@<slug>/pending-approvals/<id>/reject
 *   - `approvals.bulk({ action, criteria, reason? })`-> POST   /@<slug>/pending-approvals/bulk
 *   - `approvals.comments.add(id, { body, visibility })` -> POST /@<slug>/pending-approvals/<id>/comments
 *   - `approvals.comments.list(id, { limit?, cursor? })` -> GET  /@<slug>/pending-approvals/<id>/comments
 *   - `approvalPolicies.list()`                      -> GET    /@<slug>/approval-policies
 *   - `approvalPolicies.create({...})`               -> POST   /@<slug>/approval-policies
 *   - `approvalPolicies.delete(id)`                  -> DELETE /@<slug>/approval-policies/<id>
 *
 * `approvals.list` is cursor-paginated, newest first: pass `meta.cursor.next` of one page as `cursor` of the next, until it
 * is null. A cursor belongs to the `status` filter it was issued for. Project admins and auditors see the whole queue;
 * other members see only the changes they proposed.
 */

import { request, type HttpClientConfig } from "./http.ts";
import { KError } from "./kerror.ts";
import { projectPath } from "./url-grammar.ts";
import type { Envelope, PaginatedEnvelope } from "./envelope.ts";

export type PendingChangeStatus = "pending_approval" | "approved" | "rejected" | "expired" | "redeemed";
export type ApprovalOperation = "insert" | "update" | "delete";

/** A change waiting for (or past) a decision. */
export type PendingChange = {
  /** `apr_<base62>`. */
  id: string;
  status: PendingChangeStatus;
  collection: string;
  operation: ApprovalOperation;
  makerId: string;
  /** The proposed record for a data write; for other kinds of change, a description of the action. */
  proposedPayload: Record<string, unknown>;
  targetRecordId: string | null;
  approverId: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  createdAt: string;
  expiresAt: string | null;
};

/**
 * What a write answers with when it was queued instead of applied (HTTP 202): the change as it was proposed. Decision
 * fields (`approverId`, `decidedAt`, `decisionReason`, `createdAt`, `expiresAt`) are not part of this answer; read the
 * full change with `approvals.get(id)`.
 */
export type QueuedChange = {
  /** `apr_<base62>`; pass it to `approvals.get`, `approve` or `reject`. */
  id: string;
  status: "pending_approval";
  collection: string;
  operation: ApprovalOperation;
  makerId: string;
  /** Insert: the record. Update: the patch. Delete: `{}`. */
  proposedPayload: Record<string, unknown>;
  /** The record the change targets; `null` for an insert. */
  targetRecordId: string | null;
};

/** The envelope of a queued write: `meta.approval.status` repeats `data.status`. */
export type QueuedWrite = {
  data: QueuedChange;
  meta: Record<string, unknown> & { approval: { status: "pending_approval" } };
};

/**
 * Answer of a single-record write sent with `requireApproval`: the queued change, or the normal envelope of the write
 * when an `auto_approve` policy applied it at once. Tell them apart with {@link isQueuedWrite}.
 */
export type ApprovalGatedWrite<Row> = QueuedWrite | Envelope<Row>;

/** True when a write was queued for approval (HTTP 202) instead of applied. */
export function isQueuedWrite<Row>(result: ApprovalGatedWrite<Row>): result is QueuedWrite {
  const approval = (result.meta as { approval?: { status?: unknown } }).approval;
  const data = result.data as { status?: unknown } | null | undefined;
  return approval?.status === "pending_approval" && data !== null && typeof data === "object" && data.status === "pending_approval";
}

export type ListApprovalsOptions = {
  /** Only changes in this status. Omit for all. */
  status?: PendingChangeStatus | undefined;
  /** 1 to 200; the gateway defaults to 50. */
  limit?: number | undefined;
  /** `meta.cursor.next` of the previous page. An invalid cursor, or one issued for another `status`, is a 400 `K9O_INVALID_CURSOR`. */
  cursor?: string | undefined;
};

export type ApproveInput = {
  /** Optional note stored with the decision. */
  reason?: string | null | undefined;
};

export type RejectInput = {
  /** Required, non-empty. */
  reason: string;
};

/**
 * Answer of `approve`. When the change needs several approvers, a 200 whose `status` is still `pending_approval`
 * means your approval was recorded and more approvers are needed; the change has not been applied yet. A change
 * that applies inline ends `redeemed`; some kinds of change end `approved` and are applied by a later step.
 */
export type ApproveResult = PendingChange;

/** A predicate tree in the policy grammar, for example `{ gt: ["change.row.amount", 1000] }`. */
export type ApprovalPredicate = Record<string, unknown>;

export type BulkApprovalsInput = {
  action: "approve" | "reject";
  /**
   * Selects the pending changes to decide. Operands are `change.table`, `change.operation`, `change.row.<field>`,
   * `change.fields_modified`, `change.magnitude`, `change.created_at`, `maker.id` and `maker.account_type`.
   */
  criteria: ApprovalPredicate;
  /** Required when `action` is `reject`. */
  reason?: string | null | undefined;
};

/** A pending change that a bulk call matched but could not decide. */
export type BulkApprovalFailure = {
  /** The pending change. */
  id: string;
  /** What went wrong, for example `K9O_STATE_CONFLICT`. An open set: treat it as a string. */
  code: string;
  /** The error message for this row (not the decision reason). */
  reason: string;
};

/**
 * Answer of `bulk`. The HTTP status is 200 even when rows fail: every matched row is in `affectedIds` (decided) or in
 * `failed` (not decided, with its error). Rows are decided one at a time and rows already decided are not rolled back,
 * so compare `affectedIds` with the set you meant to decide. `failed` is empty when nothing failed.
 */
export type BulkApprovalsResult = {
  attestationId: string;
  action: "approve" | "reject";
  affectedCount: number;
  affectedIds: ReadonlyArray<string>;
  failed: ReadonlyArray<BulkApprovalFailure>;
  reason: string | null;
};

export type ApprovalAction = "auto_approve" | "queue";

/** A rule: writes to `collection` with `operation` that match `predicate` get `action`. */
export type ApprovalPolicy = {
  /** `apo_<base62>`. */
  id: string;
  collection: string;
  operation: ApprovalOperation;
  predicate: ApprovalPredicate;
  action: ApprovalAction;
  authoredBy: string;
  createdAt: string;
};

export type CreateApprovalPolicyInput = {
  /** `^[a-zA-Z_][a-zA-Z0-9_]{0,62}$`. */
  collection: string;
  operation: ApprovalOperation;
  action: ApprovalAction;
  /** A non-null predicate object. */
  predicate: ApprovalPredicate;
};

/** Who can read a comment. Fixed when it is posted. */
export type ApprovalCommentVisibility = "everyone" | "approvers_only";

/** A comment on a pending change. A comment is never a decision. */
export type ApprovalComment = {
  /** `acm_<base62>`. */
  id: string;
  /** The pending change the comment is on. */
  caseId: string;
  /** The author's opaque user id. */
  authorId: string;
  visibility: ApprovalCommentVisibility;
  /** Plain text. Render it as text, never as HTML. */
  body: string;
  createdAt: string;
};

export type AddApprovalCommentInput = {
  /** Plain text, 1 to 4,000 characters. */
  body: string;
  /** Required. `everyone`: everyone who can read the case. `approvers_only`: only people eligible to decide it. */
  visibility: ApprovalCommentVisibility;
};

export type ListApprovalCommentsOptions = {
  /** 1 to 200; the gateway defaults to 50. */
  limit?: number | undefined;
  /** `nextCursor` of the previous page. */
  cursor?: string | undefined;
};

/** One page of comments, oldest first: `nextCursor` is the cursor for the next page, `null` on the last. */
export type ApprovalCommentPage = {
  data: ReadonlyArray<ApprovalComment>;
  nextCursor: string | null;
  meta: Record<string, unknown>;
};

const COMMENT_MAX_CHARS = 4000;

const COLLECTION_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;

function invalid(message: string, context: Record<string, unknown> = {}): KError {
  return new KError({ code: "K9O_INVALID_FIELD_VALUE", message, context, recommendation: null });
}

function requireProjectSlug(config: HttpClientConfig, what: string): string {
  if (typeof config.projectSlug !== "string" || config.projectSlug.length === 0) {
    throw new Error(`${what} operations require projectSlug bound on the client`);
  }
  return config.projectSlug;
}

function requireId(id: unknown, what: string): string {
  if (typeof id !== "string" || id.length === 0) throw invalid(`${what} id must be a non-empty string`);
  return id;
}

function requireReason(reason: unknown): string {
  if (typeof reason !== "string" || reason.trim().length === 0) throw invalid("reason is required and must be a non-empty string");
  return reason;
}

function requirePredicate(value: unknown, field: string): ApprovalPredicate {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalid(`${field} must be a predicate object`);
  return value as ApprovalPredicate;
}

export function makeApprovalsNamespace(config: HttpClientConfig) {
  const path = (tail: string): string => projectPath(requireProjectSlug(config, "approvals"), `pending-approvals${tail}`);
  const commentsPath = (id: unknown): string => path(`/${encodeURIComponent(requireId(id, "approval"))}/comments`);
  const comments = {
    /**
     * Post a comment on a pending change. `visibility` is required and cannot be changed afterwards; there is no edit
     * and no delete. Needs a session (a personal access token alone is refused with 403 `K9O_RBAC_DENY`). 403
     * `K9O_APPROVAL_COMMENT_NOT_ELIGIBLE` when the caller may not post it; 409 `K9O_APPROVAL_COMMENT_CLOSED` when the
     * change is decided, expired or cancelled.
     */
    async add(id: string, input: AddApprovalCommentInput): Promise<Envelope<ApprovalComment>> {
      const target = commentsPath(id);
      if (input === null || typeof input !== "object") throw invalid("comment input must be an object");
      if (typeof input.body !== "string" || input.body.length === 0 || Array.from(input.body).length > COMMENT_MAX_CHARS) {
        throw invalid(`body must be a string of 1 to ${COMMENT_MAX_CHARS} characters`);
      }
      if (input.visibility !== "everyone" && input.visibility !== "approvers_only") {
        throw invalid('visibility must be "everyone" or "approvers_only"', { visibility: input.visibility });
      }
      return request(config, { method: "POST", path: target, body: { body: input.body, visibility: input.visibility } });
    },

    /**
     * Comments on a pending change, oldest first, one page at a time: only the ones the caller may see. Pass
     * `nextCursor` of one page as `cursor` of the next until it is null.
     */
    async list(id: string, opts: ListApprovalCommentsOptions = {}): Promise<ApprovalCommentPage> {
      const target = commentsPath(id);
      if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit < 1 || opts.limit > 200)) {
        throw invalid("limit must be a whole number from 1 to 200", { limit: opts.limit });
      }
      const page = await request<ReadonlyArray<ApprovalComment>>(config, {
        method: "GET",
        path: target,
        query: { limit: opts.limit, cursor: opts.cursor },
      });
      const raw = page as unknown as { nextCursor?: unknown };
      return { ...page, nextCursor: typeof raw.nextCursor === "string" ? raw.nextCursor : null } as ApprovalCommentPage;
    },
  };
  return {
    comments,
    /** List pending changes, newest first, one page at a time. The next cursor is `meta.cursor.next` (null on the last page). */
    async list(opts: ListApprovalsOptions = {}): Promise<PaginatedEnvelope<ReadonlyArray<PendingChange>>> {
      if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit < 1 || opts.limit > 200)) {
        throw invalid("limit must be a whole number from 1 to 200", { limit: opts.limit });
      }
      const page = await request<ReadonlyArray<PendingChange>>(config, {
        method: "GET",
        path: path(""),
        query: { status: opts.status, limit: opts.limit, cursor: opts.cursor },
      });
      return page as PaginatedEnvelope<ReadonlyArray<PendingChange>>;
    },

    /** One pending change. Members who are not queue admins can read only their own. */
    async get(id: string): Promise<Envelope<PendingChange>> {
      return request(config, { method: "GET", path: path(`/${encodeURIComponent(requireId(id, "approval"))}`) });
    },

    /**
     * Approve a pending change. Read `status` on the answer: `pending_approval` means the approval was recorded but
     * more approvers are needed.
     */
    async approve(id: string, input: ApproveInput = {}): Promise<Envelope<ApproveResult>> {
      return request(config, {
        method: "POST",
        path: path(`/${encodeURIComponent(requireId(id, "approval"))}/approve`),
        body: input.reason === undefined ? {} : { reason: input.reason },
      });
    },

    /** Reject a pending change. `reason` is required. */
    async reject(id: string, input: RejectInput): Promise<Envelope<PendingChange>> {
      const reason = requireReason(input?.reason);
      return request(config, {
        method: "POST",
        path: path(`/${encodeURIComponent(requireId(id, "approval"))}/reject`),
        body: { reason },
      });
    },

    /**
     * Approve or reject every pending change matching `criteria`. The answer is 200 even when rows fail: read `failed`
     * and compare `affectedIds` with what you intended.
     */
    async bulk(input: BulkApprovalsInput): Promise<Envelope<BulkApprovalsResult>> {
      if (input === null || typeof input !== "object") throw invalid("bulk input must be an object");
      if (input.action !== "approve" && input.action !== "reject") throw invalid('action must be "approve" or "reject"');
      const criteria = requirePredicate(input.criteria, "criteria");
      const body: Record<string, unknown> = { action: input.action, criteria };
      if (input.action === "reject") body["reason"] = requireReason(input.reason);
      else if (input.reason !== undefined) body["reason"] = input.reason;
      const result = await request<BulkApprovalsResult>(config, { method: "POST", path: path("/bulk"), body });
      const data = result.data as Omit<BulkApprovalsResult, "failed"> & { failed?: ReadonlyArray<BulkApprovalFailure> | null };
      return { ...result, data: { ...data, failed: data.failed ?? [] } };
    },
  };
}

export function makeApprovalPoliciesNamespace(config: HttpClientConfig) {
  const path = (tail: string): string => projectPath(requireProjectSlug(config, "approvalPolicies"), `approval-policies${tail}`);
  return {
    /** All policies, oldest first. The first matching policy for a write decides. */
    async list(): Promise<Envelope<ReadonlyArray<ApprovalPolicy>>> {
      return request(config, { method: "GET", path: path("") });
    },

    /** Create a policy. Identical policies are not de-duplicated. */
    async create(input: CreateApprovalPolicyInput): Promise<Envelope<ApprovalPolicy>> {
      if (input === null || typeof input !== "object") throw invalid("input must be an object");
      if (typeof input.collection !== "string" || !COLLECTION_RE.test(input.collection)) {
        throw invalid("collection must match ^[a-zA-Z_][a-zA-Z0-9_]{0,62}$", { collection: input.collection });
      }
      if (input.operation !== "insert" && input.operation !== "update" && input.operation !== "delete") {
        throw invalid('operation must be "insert", "update" or "delete"');
      }
      if (input.action !== "auto_approve" && input.action !== "queue") throw invalid('action must be "auto_approve" or "queue"');
      const predicate = requirePredicate(input.predicate, "predicate");
      return request(config, {
        method: "POST",
        path: path(""),
        body: { collection: input.collection, operation: input.operation, action: input.action, predicate },
      });
    },

    /** Delete a policy; answers `{ id }`. */
    async delete(id: string): Promise<Envelope<{ id: string }>> {
      return request(config, { method: "DELETE", path: path(`/${encodeURIComponent(requireId(id, "policy"))}`) });
    },
  };
}
