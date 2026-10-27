import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// The watch ID is a SHA-256 hash of a random browser cookie, never an email or IP.
export const huntWatches = sqliteTable('hunt_watches', {
  id: text('id').primaryKey(),
  settingsJson: text('settings_json').notNull(),
  jobKey: text('job_key').notNull(),
  enabled: integer('enabled').notNull().default(0),
  expiresAt: integer('expires_at'),
  requestedAt: integer('requested_at'),
  completionJson: text('completion_json'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (table) => [index('hunt_watches_job_idx').on(table.jobKey), index('hunt_watches_expiry_idx').on(table.enabled, table.expiresAt)]);

// Results are public stock observations shared by everyone checking the same SKU/ZIP.
export const huntJobs = sqliteTable('hunt_jobs', {
  key: text('key').primaryKey(),
  zip: text('zip').notNull(),
  variantJson: text('variant_json').notNull(),
  stateJson: text('state_json').notNull().default('{}'),
  checkedAt: integer('checked_at'),
  requestedAt: integer('requested_at'),
  lastAttemptAt: integer('last_attempt_at'),
  createdAt: integer('created_at').notNull(),
}, (table) => [index('hunt_jobs_checked_idx').on(table.checkedAt), index('hunt_jobs_zip_idx').on(table.zip)]);

// A single CAS-protected row reserves every upstream pickup request before fetch.
export const huntEngine = sqliteTable('hunt_engine', {
  id: text('id').primaryKey(),
  revision: integer('revision').notNull().default(0),
  requestTimesJson: text('request_times_json').notNull().default('[]'),
  backoffUntil: integer('backoff_until').notNull().default(0),
  failureCount: integer('failure_count').notNull().default(0),
  lockedUntil: integer('locked_until').notNull().default(0),
  lockToken: text('lock_token'),
  nextAllowedAt: integer('next_allowed_at').notNull().default(0),
  lastTickAt: integer('last_tick_at'),
  lastTickJson: text('last_tick_json'),
});

export const huntCatalog = sqliteTable('hunt_catalog', {
  id: text('id').primaryKey(),
  payloadJson: text('payload_json').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const huntRateLimits = sqliteTable('hunt_rate_limits', {
  id: text('id').primaryKey(),
  count: integer('count').notNull(),
  resetAt: integer('reset_at').notNull(),
});

// Browser push endpoints are capability secrets: never expose these rows in public status.
export const huntPushSubscriptions = sqliteTable('hunt_push_subscriptions', {
  sessionId: text('session_id').primaryKey(), subscriptionJson: text('subscription_json').notNull(),
  endpointHash: text('endpoint_hash').notNull().unique(), publicKey: text('public_key').notNull(),
  createdAt: integer('created_at').notNull(), updatedAt: integer('updated_at').notNull(),
  lastTestAt: integer('last_test_at'), lastSentAt: integer('last_sent_at'),
  lastDisplayedAt: integer('last_displayed_at'), lastError: text('last_error'),
});

export const huntPushOutbox = sqliteTable('hunt_push_outbox', {
  id: text('id').primaryKey(), sessionId: text('session_id').notNull(), endpointHash: text('endpoint_hash').notNull(),
  jobKey: text('job_key'), storeNumber: text('store_number'), kind: text('kind').notNull(),
  payloadJson: text('payload_json').notNull(), receiptHash: text('receipt_hash').notNull(), state: text('state').notNull(),
  attempts: integer('attempts').notNull().default(0), createdAt: integer('created_at').notNull(),
  notBefore: integer('not_before').notNull(), expiresAt: integer('expires_at').notNull(), lockedUntil: integer('locked_until'),
  acceptedAt: integer('accepted_at'), displayedAt: integer('displayed_at'), lastError: text('last_error'),
}, table => [index('hunt_push_outbox_due_idx').on(table.state, table.notBefore), index('hunt_push_outbox_session_idx').on(table.sessionId)]);
