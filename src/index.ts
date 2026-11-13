/**
 * `@k9o/core` — Kilimanjaro platform SDK entry point.
 *
 * Customer-facing surface. The `createClient(options)`
 * factory returns a `K9oClient` instance with namespaces:
 *
 *   - `client.from(collection)`  — data-plane DSL
 *   - `client.projects`          — project lifecycle
 *   - `client.gate`, `client.extensions`, `client.migrations`, `client.functions`, `client.policies`,
 *     `client.audit`, `client.orgs` and the other namespaces on the client type
 *
 * `@k9o/core` composes `@k9o/gate` and `@k9o/extension-client` and adds client construction and the data-plane surface.
 * The SDK shape stays stable whether pillars are imported directly or
 * through `@k9o/core` — only the package boundary moves.
 *
 * Every async method throws `KError` on non-2xx
 * gateway responses, transport failures, or SDK-side validation errors.
 * Caller code narrows on `error.code` per the closed taxonomy.
 *
 * Canonical usage:
 *
 * ```typescript
 * import { createClient, KError } from "@k9o/core";
 *
 * // `orgSlug` selects your organization's host (https://acme.api.k9o.io); do not also pass `baseUrl`.
 * const client = createClient({
 *   apiKey: process.env.K9O_API_KEY,
 *   orgSlug: "acme",
 *   projectSlug: "member-portal",
 * });
 *
 * try {
 *   const { data, meta } = await client.from("posts").select().limit(10);
 *   console.log(data, meta.cursor.next);
 * } catch (e) {
 *   if (e instanceof KError && e.code === "K9O_TIER_CAP_HIT") {
 *     console.warn(e.message, e.recommendation);
 *   }
 *   throw e;
 * }
 * ```
 */

import { resolveBaseUrl } from "./url-grammar.ts";
import type { HttpClientConfig } from "./http.ts";
import { makeFromFactory } from "./data/from.ts";
import { makeProjectsNamespace } from "./projects.ts";
import { makeStorageNamespace } from "./storage-locations.ts";
export type {
  StorageBucket, CreateBucketOptions, UpdateBucketOptions, StorageObject, UploadOptions, SignedUrlOptions,
  SignedUrl, RemovedObject, DeletedBucket,
} from "./storage-buckets.ts";
import { makeMigrationsNamespace } from "./migrations.ts";
import { makeFunctionsNamespace } from "./functions.ts";
import { makePoliciesNamespace } from "./policies.ts";
import { makeAuditNamespace } from "./audit.ts";
import { makeOrgsNamespace } from "./orgs.ts";
import { makeOrgNamespace } from "./org.ts";
import { makeMeNamespace } from "./me.ts";
import { makeStudioNamespace } from "./studio/index.ts";
import { makeComputeNamespace } from "./compute/llms.ts";
import { makeAiNamespace } from "./ai.ts";
import { makeQuery } from "./query.ts";
import { makeSearch } from "./search.ts";
import { makeRealtimeNamespace } from "./realtime.ts";
import { makeStreamsNamespace } from "./streams.ts";
import { makeApprovalsNamespace, makeApprovalPoliciesNamespace } from "./approvals.ts";
import { makeSchemaNamespace } from "./schema.ts";
import { makeSchedulesNamespace } from "./schedules.ts";
import { makeVectorsNamespace } from "./vectors.ts";
export type {
  MetadataOp, MetadataWhere, MetadataRow, MetadataPage, MetadataFilterInput, MetadataSearchInput, MetadataMetric, MetadataNearestInput,
  MetadataRecord, MetadataChange, MetadataChangeEvent, MetadataSubscribeOptions, MetadataIndexColumn, MetadataIndex,
} from "./metadata.ts";
import { makeMetadataNamespace } from "./metadata.ts";
import { makeCustodyNamespace } from "./custody.ts";
import { makeAnalyticsNamespace, makeRollupsNamespace } from "./analytics.ts";
import { makeKeysNamespace } from "./keys.ts";
import { makeCryptoNamespace, checkExpectedKeyRefs } from "./crypto.ts";
export { CRYPTO_MAX_ITEMS, CRYPTO_MAX_ITEM_BYTES, CRYPTO_MAX_CALL_BYTES, CRYPTO_MAX_CONTEXT_BYTES, CRYPTO_ERR_ZK_STORE_FLOW_REQUIRED, CRYPTO_ERR_ZK_CLIENT_CORE_UNAVAILABLE, CRYPTO_ERR_CUSTODY_UNKNOWN, CRYPTO_ERR_CRYPT_NOT_FOUND, CRYPTO_ERR_CRYPT_RETIRED, CRYPTO_ERR_KEY_PIN_UNENFORCED, keyRefMatches, checkExpectedKeyRefs } from "./crypto.ts";
export type {
  CryptoInput, EncryptItem, CiphertextItem, EncryptRequest, DecryptRequest, RewrapRequest, CryptoItemFailure, CiphertextResult, PlaintextResult, EncryptResult, DecryptResult, RewrapResult, CryptoMode, FederatedTokenRequest, FederatedToken, Crypt, ClientCryptoCore, ClientCoreEncryptItem, ClientCoreOptions, KeyRefProvider,
} from "./crypto.ts";
export { stepUpChallengeOf, STEP_UP_HEADER } from "./keys.ts";
import { makeRampartNamespace } from "./rampart.ts";
import { makeEndUsersNamespace } from "./end-users.ts";
import { makeGateBridge, gateNotAvailable } from "./gate-bridge.ts";
import { makeExtensionsBridge } from "./extensions-bridge.ts";
import type { GateClient } from "@k9o/gate";
import { createKiboClient, type KiboClient } from "@k9o/kibo";
import type { CreateClientOptions } from "./types.ts";

export { KError, kerrorFromWire, type KErrorWire } from "./kerror.ts";
export {
  type Envelope,
  type MetaCursor,
  type MetaSubscription,
  type MetaIdempotency,
  type MetaWarning,
  type MetaCost,
  type MetaTiming,
  type MetaContext,
  type PaginatedEnvelope,
} from "./envelope.ts";
export {
  validateBaseUrl,
  resolveBaseUrl,
  parseApiHost,
  DEFAULT_BASE_URL,
  type ApiHost,
  validateSlug,
  projectPath,
  orgPath,
  platformPath,
} from "./url-grammar.ts";
export type {
  CreateClientOptions,
  RetryConfig,
  FilterOp,
} from "./types.ts";
export type { Project, CreateProjectInput, UpdateProjectInput } from "./projects.ts";
export {
  BYOS_CRED_REF_PREFIX,
  BYOS_CRED_FORMAT_VERSION,
  BYOS_CRED_VAULT_NAME_PREFIX,
  BYOS_PROVIDER_SCHEME,
  encodeByosCredential,
  byosCredentialRef,
  byosCredVaultName,
  type ByosCredProvider,
  type ByosCredInput,
} from "./byos.ts";
export type {
  StorageLocation, StorageLocationProvider, StorageLocationCustodyMode, StorageLocationProviderParams,
  CreateStorageLocationInput, UpdateStorageLocationInput, RetiredStorageLocation, StorageLocationTestResult,
} from "./storage-locations.ts";
export type {
  Migration, AppliedMigration, AppliedMigrationRow, SkippedMigrationRow, ApplyMigrationsResult, ApplyPendingResult,
  PendingMigration, PendingMigrationStatus, QueuedMigration,
  Operation, ColumnSpec, IndexSpec, ColumnReferences,
  MigrationPolicy, CollectionPolicy, StorageBucketPolicy, RelationshipSpec, ActionRule,
} from "./migrations.ts";
export type {
  FunctionRecord, DeployFunctionInput, FunctionTrigger, TriggerEvent, CreateTriggerInput, UpdateTriggerInput,
} from "./functions.ts";
export type {
  Schedule, ScheduleRun, ScheduleStatus, CatchupPolicy, ListSchedulesOptions, ListScheduleRunsOptions, CreateScheduleInput, UpdateScheduleInput,
} from "./schedules.ts";
export type {
  VectorMetric, VectorSource, VectorFilters, NearestVectorsInput, NearestVector, NearestVectorsResult, VectorRow, UpsertVectorsResult,
} from "./vectors.ts";
export type {
  EndUser, EndUserStatus, ListEndUsersOptions, EndUserRoleGrant, ListRoleGrantsOptions, GrantRoleInput, RevokeRoleGrantResult,
} from "./end-users.ts";
export type {
  PolicyBundle, PolicyDocument, PolicyPublishResult, PublishPolicyOptions, CreatePolicyInput, UpdatePolicyInput, ValidatePolicyResult,
} from "./policies.ts";
export type { AuditEvent, AuditQueryOpts, AuditTailEvent, AuditTailOptions, AuditTail, AuditReplayOptions, AuditReplayPage } from "./audit.ts";
export type {
  VaultKey, VaultKeyStatus, VaultKeyByokRef, VaultKeyHyokRef, ListKeysOptions, ListKeysResult, RotateKeyResult, RotateKeyOptions, StepUpChallenge, StepUpCall, StepUpProof, StepUpHook,
} from "./keys.ts";
export type {
  DatasetColumn, DatasetStorageTarget, CreateDatasetInput, Dataset, DatasetQueryInput, DatasetReadOptions, DatasetRow, DatasetWriteOptions,
  DatasetIngestResult, MaterializeSource, MaterializeResult, DatasetUploadOptions, DownloadedFile, ReattestDays, RollupMeasure, CreateRollupInput,
  Rollup, RollupList, ScheduleList, CreateDatasetScheduleInput, DatasetSchedule, ReattestOptions, DeleteResult, RollupReadOptions, RollupCell, RollupReadResult, RollupCellEvent, RollupStreamCell,
  RollupSubscribeOptions, RollupSubscription,
} from "./analytics.ts";
export type { Org } from "./orgs.ts";
export type {
  OrgMember,
  OrgInviteResult,
  OrgGroup,
  OrgRoleGrant,
  OrgAuditEvent,
  SmtpConfig,
  SmtpTestEmailInput,
  SmtpTestEmailResult,
  OrgIdpProvider,
  CreateOrgIdpInput,
  UpdateOrgIdpInput,
  OrgIdpProviderKind,
  OrgDefaultLlm,
} from "./org.ts";
export type {
  MyProfile,
  MySession,
  UpdateMyProfileInput,
  MyApiToken,
  CreateMyApiTokenInput,
} from "./me.ts";
export type { ExtensionSlug, Extension } from "./extensions-bridge.ts";
export type { GateClient } from "@k9o/gate";
export type {
  KiboClient, KmsProvider, StoreZkDekInput, ZkDekHandle, ZkDekRecord,
  SecretVisibility, CreateSecretInput, SecretSummary,
  ListSecretsInput, ListSecretsResult, AttestationTier, RevealChallenge, RevealSecretResult,
  UpdateSecretInput, UpdateSecretResult, RotateSecretResult, MoveSecretResult,
} from "@k9o/kibo";

// Studio surfaces (workflows + dashboards)
export {
  WORKFLOW_ERROR_CODES,
  type Workflow,
  type WorkflowRun,
  type WorkflowRunStep,
  type WorkflowAction,
  type WorkflowStatus,
  type WorkflowRunStatus,
  type WorkflowTriggerType,
  type WorkflowActionType,
  type CreateWorkflowInput,
  type UpdateWorkflowInput,
  type WorkflowListFilters,
  type WorkflowRunListFilters,
} from "./studio/workflows.ts";
export {
  DASHBOARD_ERROR_CODES,
  type Dashboard,
  type Widget,
  type WidgetType,
  type WidgetDataSourceMode,
  type DashboardStatus,
  type CreateDashboardInput,
  type UpdateDashboardInput,
  type DashboardListFilters,
} from "./studio/dashboards.ts";

// Compute LLMs
export {
  LLM_ERROR_CODES,
  type LLMModelId,
  type LLMModel,
  type LLMModality,
  type LLMProviderClass,
  type LLMInvokeParams,
  type LLMInvokeInput,
  type LLMResponse,
  type LLMUsage,
  type LLMStreamChunk,
} from "./compute/llms.ts";

export type { EmbedInput, EmbedResult, EmbeddingModelId, GenerateOptions, GenerateResult } from "./ai.ts";
export type { SearchInput } from "./search.ts";
export type { TextSearchOptions, VectorSearchOptions } from "./data/from.ts";
export { translateNamedParams, type QueryParams, type QueryValue } from "./query.ts";

export { assertProviderRegion, isProviderRegion, type ProviderRegionProvider } from "./provider-region.ts";

// Realtime subscriptions
export {
  realtimeTopic,
  type RealtimeTopic,
  type RealtimeTopicFamily,
  type RealtimeFilter,
  type RealtimeEvent,
  type RealtimeReplayEvent,
  type RealtimeReplayOptions,
  type RealtimeReplayPage,
  type RealtimeSubscription,
  type RealtimeResync,
  type SubscribeOptions,
} from "./realtime.ts";

// User data streams
export {
  STREAM_ERROR_CODES,
  type StreamRecord,
  type CreateStreamInput,
  type PublishOptions,
  type PublishResult,
  type ReplayOptions,
  type ReplayResult,
  type StreamEvent,
  type StreamSubscription,
  type SubscribeStreamOptions,
} from "./streams.ts";

// Approvals + approval policies
export { isQueuedWrite } from "./approvals.ts";
export type {
  QueuedChange,
  QueuedWrite,
  ApprovalGatedWrite,
  PendingChange,
  PendingChangeStatus,
  ApprovalOperation,
  ListApprovalsOptions,
  ApproveInput,
  RejectInput,
  ApproveResult,
  ApprovalPredicate,
  BulkApprovalsInput,
  BulkApprovalsResult,
  BulkApprovalFailure,
  ApprovalAction,
  ApprovalPolicy,
  CreateApprovalPolicyInput,
  ApprovalComment,
  ApprovalCommentVisibility,
  ApprovalCommentPage,
  AddApprovalCommentInput,
  ListApprovalCommentsOptions,
} from "./approvals.ts";

// Rampart (classification) and Moat (local model-call guard)
export type {
  RampartClassification, RampartVerdict, RampartClassifyResult, RampartClassifyOptions, RampartJwk, RampartJwks, RampartReceiptReason, RampartVerifyOptions, RampartVerified,
} from "./rampart.ts";
export { RampartReceiptError, RAMPART_RECEIPT_REASONS, RAMPART_RECEIPT_TYP, RAMPART_ERROR_CODES, isRampartInputTooLong } from "./rampart.ts";
export { canonicalize as jcsCanonicalize, JcsError } from "./jcs.ts";
export type { MoatReason, MoatSchema, MoatType, MoatOptions, MoatMessage, MoatPiiFilter, MoatPiiResult } from "./moat.ts";
export { Moat, MoatRefusal, MoatConfigError, MOAT_REASONS } from "./moat.ts";
export * as moat from "./moat.ts";

// Custody
export type { CustodyStatus, CustodyJob, CustodyHsm } from "./custody.ts";

// Schema
export type { CollectionSummary, ListCollectionsOptions, CollectionDetail, CollectionColumn, CollectionIndex, CollectionRelationship } from "./schema.ts";

/**
 * The client returned by `createClient`. Namespaces hang off the
 * instance — composed from per-resource factories that share the
 * bound HTTP config.
 */
export type K9oClient = {
  /** Data-plane DSL — `client.from(collection).select()` etc. */
  from: ReturnType<typeof makeFromFactory>;
  /** Parameterised read-only SQL — `client.query("SELECT … WHERE role = :role", { role: "admin" })`. */
  query: ReturnType<typeof makeQuery>;
  /** Full-text search over a collection column — `client.search("articles", { column: "body", q: "climate" })`. */
  search: ReturnType<typeof makeSearch>;
  /** Project lifecycle — `client.projects.list()` etc. */
  projects: ReturnType<typeof makeProjectsNamespace>;
  /** Storage locations — `client.storage.locations.create({..., credentialRef})` etc. Independent of
   *  `client.kibo.vault.secrets` (credential pre-create): this namespace only registers a caller-supplied
   *  `credentialRef` string, never creates or resolves one. */
  storage: ReturnType<typeof makeStorageNamespace>;
  /** Migration lifecycle — `client.migrations.apply()` etc. */
  migrations: ReturnType<typeof makeMigrationsNamespace>;
  /** Function deploy + invoke — `client.functions.deploy()` etc. */
  functions: ReturnType<typeof makeFunctionsNamespace>;
  /** Policy bundle lifecycle — `client.policies.publish()` etc. */
  policies: ReturnType<typeof makePoliciesNamespace>;
  /** Audit log: `client.audit.query()`, `.tail()` (live), `.replay()`. */
  audit: ReturnType<typeof makeAuditNamespace>;
  /** Org lifecycle — `client.orgs.list()` etc. (collection-style across accessible orgs) */
  orgs: ReturnType<typeof makeOrgsNamespace>;
  /** Org-bound namespace — `client.org.members`, `client.org.groups`, `client.org.smtp`, `client.org.auditLog`, `client.org.gate`. */
  org: ReturnType<typeof makeOrgNamespace>;
  /** Operator-self namespace — `client.me.profile`, `client.me.sessions`, etc. Cross-org; no tenant context required. */
  me: ReturnType<typeof makeMeNamespace>;
  /** Studio surfaces — `client.studio.workflows.*` + `client.studio.dashboards.*`. */
  studio: ReturnType<typeof makeStudioNamespace>;
  /** Compute surfaces — `client.compute.llms.*`. */
  compute: ReturnType<typeof makeComputeNamespace>;
  /** Platform AI primitives — `client.ai.embed({ model?, input })`, `client.ai.generate(prompt, options?)`. */
  ai: ReturnType<typeof makeAiNamespace>;
  /** Realtime subscriptions — `client.realtime.subscribe()` (SSE). */
  realtime: ReturnType<typeof makeRealtimeNamespace>;
  /** User data streams: `client.streams.publish()`, `.replay()`, `.subscribe()` (SSE), and create/list/get/delete. */
  streams: ReturnType<typeof makeStreamsNamespace>;
  /** Pending-change queue: `client.approvals.list()`, `.get()`, `.approve()`, `.reject()`, `.bulk()`. */
  approvals: ReturnType<typeof makeApprovalsNamespace>;
  /** Approval rules: `client.approvalPolicies.list()`, `.create()`, `.delete()`. */
  approvalPolicies: ReturnType<typeof makeApprovalPoliciesNamespace>;
  /** Schema reads: `client.schema.collections.list()`, `.get(name)`. */
  schema: ReturnType<typeof makeSchemaNamespace>;
  /** Scheduled triggers: `client.schedules.list()`, `.create()`, `.update()`, `.runs()`, `.runNow()`. */
  schedules: ReturnType<typeof makeSchedulesNamespace>;
  /** Embedding collections: `client.vectors.nearest()` searches with a vector in the request body, `.upsert()` stores rows. */
  vectors: ReturnType<typeof makeVectorsNamespace>;
  /** Declared metadata columns: `client.metadata.filter()`, `.set()`, `.search()`, `.vectors.nearest()`, `.subscribe()`, `.index.get()`, `.index.declare()`. */
  metadata: ReturnType<typeof makeMetadataNamespace>;
  /** Datasets: `client.analytics.create()`, `.write()`, `.query()`, `.read()`, `.upload()`, plus `.rollups.*` and `.schedules.*`. */
  analytics: ReturnType<typeof makeAnalyticsNamespace>;
  /** Rollups across the project: `client.rollups.list()`, `.read()`, `.subscribe()`. */
  rollups: ReturnType<typeof makeRollupsNamespace>;
  /** Encryption key inventory: `client.keys.list()`, `.get()`, `.rotate()`. */
  keys: ReturnType<typeof makeKeysNamespace>;
  /** Server-side encryption with the project key: `client.crypto.encrypt()`, `.decrypt()`, `.rewrap()`. */
  crypto: ReturnType<typeof makeCryptoNamespace>;
  /** Key custody (read-only): `client.custody.status()`. */
  custody: ReturnType<typeof makeCustodyNamespace>;
  /** Hosted classification (advisory): `client.rampart.classify()`, `.jwks()`, `.verifyReceipt()`. */
  rampart: ReturnType<typeof makeRampartNamespace>;
  /** End users and their roles: `client.endUsers.list()`, `.get()`, `.roleGrants.grant()`. */
  endUsers: ReturnType<typeof makeEndUsersNamespace>;
  /** Gate (Identity-Aware Kernel) — composed from `@k9o/gate`. Available when projectSlug is bound on the client. */
  readonly gate: GateClient;
  /** Kibo (Zero-Knowledge vault) — composed from `@k9o/kibo`. `client.kibo.vault.zkDeks.*` (F.5); project-scoped methods self-guard the project context. */
  readonly kibo: KiboClient;
  /** Extensions consumption — composed from `@k9o/extension-client`. `client.extensions.extension(slug)` returns typed extension bindings. */
  extensions: ReturnType<typeof makeExtensionsBridge>;
  /** Bound config — exposed for advanced use (custom HTTP per-call). */
  readonly config: Readonly<HttpClientConfig>;
};

/**
 * Construct a `K9oClient` bound to the supplied gateway baseUrl + auth
 * + project context. Validates the baseUrl at construct time
 * — path-bearing baseUrls throw `K9O_INVALID_BASE_URL` synchronously.
 */
export function createClient(options: CreateClientOptions): K9oClient {
  const baseUrl = resolveBaseUrl(options.baseUrl, options.orgSlug);
  const config: HttpClientConfig = {
    baseUrl,
    apiKey: options.apiKey,
    projectSlug: options.projectSlug,
    orgSlug: options.orgSlug,
    fetch: options.fetch,
    defaultHeaders: options.defaultHeaders,
    retryConfig: options.retryConfig,
    expectedKeyRefs: checkExpectedKeyRefs(options.expectedKeyRefs),
  };
  const gateBridge = makeGateBridge(config);
  return {
    from: makeFromFactory(config),
    query: makeQuery(config),
    search: makeSearch(config),
    projects: makeProjectsNamespace(config),
    storage: makeStorageNamespace(config),
    migrations: makeMigrationsNamespace(config),
    functions: makeFunctionsNamespace(config),
    policies: makePoliciesNamespace(config),
    audit: makeAuditNamespace(config),
    orgs: makeOrgsNamespace(config),
    org: makeOrgNamespace(config),
    me: makeMeNamespace(config),
    studio: makeStudioNamespace(config),
    compute: makeComputeNamespace(config),
    ai: makeAiNamespace(config),
    realtime: makeRealtimeNamespace(config),
    streams: makeStreamsNamespace(config),
    approvals: makeApprovalsNamespace(config),
    approvalPolicies: makeApprovalPoliciesNamespace(config),
    schema: makeSchemaNamespace(config),
    schedules: makeSchedulesNamespace(config),
    vectors: makeVectorsNamespace(config),
    metadata: makeMetadataNamespace(config),
    analytics: makeAnalyticsNamespace(config),
    rollups: makeRollupsNamespace(config),
    keys: makeKeysNamespace(config),
    crypto: makeCryptoNamespace(config),
    custody: makeCustodyNamespace(config),
    rampart: makeRampartNamespace(config),
    endUsers: makeEndUsersNamespace(config),
    // gate is a proxy — null when projectSlug isn't bound; surfacing a
    // helpful K9O_MISSING_PROJECT_CONTEXT instead of a null deref when
    // the caller reaches for any gate method without project context.
    get gate() {
      if (gateBridge === null) return gateNotAvailable();
      return gateBridge;
    },
    extensions: makeExtensionsBridge(),
    kibo: createKiboClient(config),
    config: Object.freeze({ ...config }),
  };
}
