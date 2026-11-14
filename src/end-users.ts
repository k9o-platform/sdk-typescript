/**
 * End users SDK: `client.endUsers.*`, the people who sign in to the project's own apps.
 *
 * Wire mapping (project plane):
 *   - `list({ status?, q?, limit?, cursor? })`      -> GET    /@<slug>/end-users
 *   - `get(id)`                                     -> GET    /@<slug>/end-users/<id>
 *   - `roleGrants.list({ endUserId? })`             -> GET    /@<slug>/end-user-role-grants
 *   - `roleGrants.grant({ endUserId, role })`       -> POST   /@<slug>/end-user-role-grants
 *   - `roleGrants.revoke(grantId)`                  -> DELETE /@<slug>/end-user-role-grants/<grantId>
 *
 * Listing and reading end users needs the project admin role. Role grants are created and revoked by project admins;
 * reading them is open to a wider set of project roles.
 */

import { request, type HttpClientConfig } from "./http.ts";
import { KError } from "./kerror.ts";
import { projectPath } from "./url-grammar.ts";
import type { Envelope, PaginatedEnvelope } from "./envelope.ts";

export type EndUserStatus = "active" | "locked" | "deleted";

export type EndUser = {
  /** `eu_<base62>`. */
  id: string;
  email: string;
  emailVerifiedAt: string | null;
  status: EndUserStatus;
  createdAt: string;
  lastSigninAt: string | null;
  signInMethods: ReadonlyArray<string>;
  region: string | null;
};

export type ListEndUsersOptions = {
  /** Default: active and locked users. `all` includes deleted ones. */
  status?: EndUserStatus | "all" | undefined;
  /** Email prefix (case-sensitive), up to 320 characters. */
  q?: string | undefined;
  /** 1 to 200; the gateway defaults to 50. */
  limit?: number | undefined;
  /** `meta.cursor.next` of the previous page. */
  cursor?: string | undefined;
};

/** A role held by one end user. The role is a free string, not a fixed list. */
export type EndUserRoleGrant = {
  /** `eurg_<base62>`. */
  id: string;
  endUserId: string;
  role: string;
  grantedAt: string;
  /** The subject that granted the role. */
  grantedBy: string;
};

export type ListRoleGrantsOptions = {
  /** Only this end user's grants. An unknown id answers an empty list. */
  endUserId?: string | undefined;
};

export type GrantRoleInput = {
  /** `eu_<base62>` of an existing end user, up to 64 characters. */
  endUserId: string;
  /** Any string, 1 to 128 characters. */
  role: string;
};

export type RevokeRoleGrantResult = {
  /** `false` when the grant does not exist or was already revoked. */
  revoked: boolean;
  revokedAt: string | null;
};

function invalid(message: string, context: Record<string, unknown> = {}): KError {
  return new KError({ code: "K9O_INVALID_FIELD_VALUE", message, context, recommendation: null });
}

function requireText(value: unknown, what: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw invalid(`${what} must be a string of 1 to ${max} characters`);
  return value;
}

export function makeEndUsersNamespace(config: HttpClientConfig) {
  const path = (tail: string): string => {
    if (typeof config.projectSlug !== "string" || config.projectSlug.length === 0) {
      throw new Error("endUsers operations require projectSlug bound on the client");
    }
    return projectPath(config.projectSlug, tail);
  };
  return {
    /** List end users, newest first, one page at a time. */
    async list(opts: ListEndUsersOptions = {}): Promise<PaginatedEnvelope<ReadonlyArray<EndUser>>> {
      return (await request(config, { method: "GET", path: path("end-users"), query: { ...opts } })) as PaginatedEnvelope<ReadonlyArray<EndUser>>;
    },

    /** One end user. An unknown id is a 404 `K9O_END_USER_NOT_FOUND`. */
    async get(id: string): Promise<Envelope<EndUser>> {
      return request(config, { method: "GET", path: path(`end-users/${encodeURIComponent(requireText(id, "end user id", 64))}`) });
    },

    roleGrants: {
      /** The active grants, oldest first. Not paginated. Returns the array, not the `{ grants }` wrapper the gateway sends. */
      async list(opts: ListRoleGrantsOptions = {}): Promise<Envelope<ReadonlyArray<EndUserRoleGrant>>> {
        const r = await request<{ grants: ReadonlyArray<EndUserRoleGrant> }>(config, {
          method: "GET",
          path: path("end-user-role-grants"),
          query: { endUserId: opts.endUserId },
        });
        return { data: r.data.grants, meta: r.meta };
      },

      /**
       * Give an end user a role. Granting a role the user already holds is a 400 `K9O_INVALID_FIELD_VALUE`;
       * an unknown end user is a 404 `K9O_NOT_FOUND`. A revoked role can be granted again.
       */
      async grant(input: GrantRoleInput): Promise<Envelope<EndUserRoleGrant>> {
        if (input === null || typeof input !== "object") throw invalid("input must be an object");
        const body = { endUserId: requireText(input.endUserId, "endUserId", 64), role: requireText(input.role, "role", 128) };
        const r = await request<{ grant: EndUserRoleGrant }>(config, { method: "POST", path: path("end-user-role-grants"), body });
        return { data: r.data.grant, meta: r.meta };
      },

      /**
       * Revoke a grant (it is kept, marked revoked). An unknown or already revoked id is not an error:
       * the answer is `{ revoked: false, revokedAt: null }`.
       */
      async revoke(grantId: string): Promise<Envelope<RevokeRoleGrantResult>> {
        return request(config, { method: "DELETE", path: path(`end-user-role-grants/${encodeURIComponent(requireText(grantId, "grant id", 256))}`) });
      },
    },
  };
}
