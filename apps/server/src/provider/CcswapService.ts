// @effect-diagnostics-next-line nodeBuiltinImport:off -- SHA-256 token fingerprinting matches ccswap.py.
import * as NodeCrypto from "node:crypto";
import {
  type CcswapAccountSlot,
  type CcswapAddActiveInput,
  type CcswapAutoSettings,
  type CcswapGetStateInput,
  type CcswapProfile,
  type CcswapProfileActionInput,
  type CcswapRemoveSlotInput,
  type CcswapRunAutoInput,
  type CcswapRunAutoResult,
  type CcswapSetAliasInput,
  type CcswapSlotUsage,
  type CcswapStateSnapshot,
  type CcswapSwitchInput,
  type CcswapSwitchResult,
  type CcswapSyncT3Input,
  type CcswapSyncT3Result,
  type CcswapWindowUsage,
  CcswapOperationError,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerSettings from "../serverSettings.ts";
import {
  ensureClaudeShadowHome,
  type JsonRecord,
  readJsonRecord,
  withClaudeDirLocks,
  writeJsonRecordAtomic,
} from "./Drivers/ClaudeHomeLayout.ts";
import { ProviderRegistry } from "./ProviderRegistry.ts";

const OAUTH_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const SCOPES =
  "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";

const USAGE_CACHE_TTL_S = 150;
const USAGE_STALE_MAX_S = 1800;
const TOKEN_BUFFER_S = 300;
const HARD_LIMIT = 100;
const MAX_SLOTS = 99;
const CCSWAP_INSTANCE_PREFIX = "ccswap-slot-";

interface StoredSlot {
  readonly email?: string | undefined;
  readonly alias?: string | null | undefined;
  readonly credentials: JsonRecord;
  readonly account: JsonRecord;
  readonly added_at?: string | undefined;
}

/**
 * One account's entry in the usage.json cache shared with the Python ccswap and ccremote,
 * so the field names follow theirs (`at`, `blocked_until`, `strikes`, `error`).
 */
interface StoredUsageEntry {
  readonly at?: number;
  readonly usage?: JsonRecord;
  readonly blocked_until?: number;
  readonly strikes?: number;
  readonly error?: string;
}

/** Reads an entry, accepting the field names older T3 builds wrote. */
export function readStoredUsageEntry(raw: unknown): StoredUsageEntry {
  const record = asRecord(raw);
  const usage = record["usage"];
  const at = asNumber(record["at"]) ?? asNumber(record["fetched_at"]);
  const blockedUntil = asNumber(record["blocked_until"]) ?? asNumber(record["rate_limited_until"]);
  const strikes = asNumber(record["strikes"]) ?? asNumber(record["rate_limit_strikes"]);
  const error = asString(record["error"]);
  return {
    ...(at === undefined ? {} : { at }),
    ...(usage && typeof usage === "object" ? { usage: usage as JsonRecord } : {}),
    ...(blockedUntil === undefined ? {} : { blocked_until: blockedUntil }),
    ...(strikes === undefined ? {} : { strikes }),
    ...(error === undefined ? {} : { error }),
  };
}

function asRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function slotEmail(slot: StoredSlot): string {
  return asString(slot.account["emailAddress"]) ?? asString(slot.email) ?? "?";
}

function slotPlan(slot: StoredSlot): string | null {
  const raw =
    asString(slot.credentials["subscriptionType"]) ?? asString(slot.credentials["rateLimitTier"]);
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (lower.includes("max_20") || lower.includes("20x")) return "Claude Max 20x";
  if (lower.includes("max_5") || lower.includes("5x")) return "Claude Max 5x";
  if (lower.includes("max")) return "Claude Max";
  if (lower.includes("pro")) return "Claude Pro";
  if (lower.includes("team")) return "Claude Team";
  if (lower.includes("enterprise")) return "Claude Enterprise";
  return raw;
}

function tokenFingerprint(oauth: JsonRecord): string | null {
  const token = asString(oauth["refreshToken"]) ?? asString(oauth["accessToken"]);
  if (!token) return null;
  return NodeCrypto.createHash("sha256").update(token).digest("hex").slice(0, 16);
}

function isTokenExpired(oauth: JsonRecord, nowMs: number, bufferS = TOKEN_BUFFER_S): boolean {
  const exp = asNumber(oauth["expiresAt"]);
  if (exp === undefined) return false;
  return exp <= nowMs + bufferS * 1000;
}

function slotInstanceId(slotNum: number): ProviderInstanceId {
  return ProviderInstanceId.make(`${CCSWAP_INSTANCE_PREFIX}${slotNum}`);
}

function parseCcswapSlotFromInstanceId(instanceId: string): number | null {
  if (!instanceId.startsWith(CCSWAP_INSTANCE_PREFIX)) return null;
  const parsed = Number.parseInt(instanceId.slice(CCSWAP_INSTANCE_PREFIX.length), 10);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_SLOTS ? parsed : null;
}

function parseUsagePayload(raw: JsonRecord): JsonRecord {
  const out: JsonRecord = {};
  for (const [key, apiKey] of [
    ["5h", "five_hour"],
    ["7d", "seven_day"],
  ] as const) {
    const val = asRecord(raw[apiKey]);
    const util = asNumber(val["utilization"]);
    if (util !== undefined) {
      out[key] = { pct: util, resets_at: asString(val["resets_at"]) ?? null };
    }
  }
  const models: JsonRecord = {};
  for (const [key, val] of Object.entries(raw)) {
    if (key.startsWith("seven_day_") && key !== "seven_day_oauth_apps") {
      const rec = asRecord(val);
      const util = asNumber(rec["utilization"]);
      if (util !== undefined) {
        const modelName = key.replace(/^seven_day_/, "");
        models[modelName] = { pct: util, resets_at: asString(rec["resets_at"]) ?? null };
      }
    }
  }
  if (Object.keys(models).length > 0) {
    out["models"] = models;
  }
  return out;
}

function toContractWindow(raw: unknown): CcswapWindowUsage | null {
  const rec = asRecord(raw);
  const pct = asNumber(rec["pct"]);
  if (pct === undefined) return null;
  return {
    pct,
    resetsAt: asString(rec["resets_at"]) ?? null,
  };
}

function toContractUsage(
  raw: JsonRecord | null,
  checkedAt: number | null,
  stale: boolean,
  error: string | null,
): CcswapSlotUsage | null {
  if (!raw && !error) return null;
  const modelWindows: Record<string, CcswapWindowUsage> = {};
  if (raw) {
    const models = asRecord(raw["models"]);
    for (const [name, entry] of Object.entries(models)) {
      const win = toContractWindow(entry);
      if (win) modelWindows[name] = win;
    }
  }
  return {
    fiveHour: raw ? toContractWindow(raw["5h"]) : null,
    sevenDay: raw ? toContractWindow(raw["7d"]) : null,
    modelWindows,
    checkedAt,
    stale,
    error,
  };
}

function worstWindow(
  usage: JsonRecord | null,
  models: ReadonlyArray<string>,
): { readonly name: string; readonly pct: number } | null {
  if (!usage) return null;
  const candidates: Array<{ name: string; pct: number }> = [];
  for (const key of ["5h", "7d"] as const) {
    const win = toContractWindow(usage[key]);
    if (win) candidates.push({ name: key, pct: win.pct });
  }
  const modelMap = asRecord(usage["models"]);
  for (const model of models) {
    const needle = model.toLowerCase();
    for (const [name, entry] of Object.entries(modelMap)) {
      if (name.toLowerCase() === needle || name.toLowerCase().includes(needle)) {
        const win = toContractWindow(entry);
        if (win) candidates.push({ name: `7d:${name}`, pct: win.pct });
      }
    }
  }
  if (candidates.length === 0) return null;
  return candidates.reduce((best, cur) => (cur.pct > best.pct ? cur : best));
}

function worstPct(usage: JsonRecord | null, models: ReadonlyArray<string>): number | null {
  return worstWindow(usage, models)?.pct ?? null;
}

/**
 * Picks the slot a turn should run on. The current account keeps its quota until the
 * threshold; past it, the least used account below the threshold wins, and an account
 * above the threshold is only taken once the current one is fully exhausted.
 */
export function pickTurnSlot(input: {
  readonly currentPct: number | null;
  readonly candidates: ReadonlyArray<{ readonly slot: number; readonly pct: number | null }>;
  readonly threshold: number;
}): number | null {
  const { currentPct, threshold } = input;
  if (currentPct === null || currentPct < threshold) return null;
  const known = input.candidates.flatMap((c) => (c.pct === null ? [] : [{ ...c, pct: c.pct }]));
  const leastUsed = (limit: number) =>
    known
      .filter((c) => c.pct < limit)
      .reduce<{ slot: number; pct: number } | null>(
        (best, c) => (best === null || c.pct < best.pct ? c : best),
        null,
      )?.slot ?? null;
  return leastUsed(threshold) ?? (currentPct >= HARD_LIMIT ? leastUsed(HARD_LIMIT) : null);
}

function availableAt(
  usage: JsonRecord | null,
  models: ReadonlyArray<string>,
  threshold: number,
): number | null {
  if (!usage) return null;
  const windows: Array<{ pct: number; resetsAt: string | null }> = [];
  for (const key of ["5h", "7d"] as const) {
    const win = toContractWindow(usage[key]);
    if (win) windows.push(win);
  }
  const modelMap = asRecord(usage["models"]);
  for (const model of models) {
    const needle = model.toLowerCase();
    for (const [name, entry] of Object.entries(modelMap)) {
      if (name.toLowerCase() === needle || name.toLowerCase().includes(needle)) {
        const win = toContractWindow(entry);
        if (win) windows.push(win);
      }
    }
  }
  const blocking = windows.filter((w) => w.pct >= threshold);
  if (blocking.length === 0) return null;
  let latest = 0;
  for (const w of blocking) {
    if (!w.resetsAt) return null;
    const ms = Date.parse(w.resetsAt);
    if (!Number.isFinite(ms)) return null;
    if (ms > latest) latest = ms;
  }
  return latest > 0 ? latest : null;
}

const isCcswapOperationError = Schema.is(CcswapOperationError);
const mapOpError = (err: unknown): CcswapOperationError =>
  isCcswapOperationError(err)
    ? err
    : new CcswapOperationError({ message: err instanceof Error ? err.message : String(err) });

export interface CcswapServiceShape {
  readonly getState: (
    input?: CcswapGetStateInput,
  ) => Effect.Effect<CcswapStateSnapshot, CcswapOperationError>;
  readonly addActive: (
    input: CcswapAddActiveInput,
  ) => Effect.Effect<CcswapStateSnapshot, CcswapOperationError>;
  readonly removeSlot: (
    input: CcswapRemoveSlotInput,
  ) => Effect.Effect<CcswapStateSnapshot, CcswapOperationError>;
  readonly setAlias: (
    input: CcswapSetAliasInput,
  ) => Effect.Effect<CcswapStateSnapshot, CcswapOperationError>;
  readonly switchAccount: (
    input: CcswapSwitchInput,
  ) => Effect.Effect<CcswapSwitchResult, CcswapOperationError>;
  readonly profileAction: (
    input: CcswapProfileActionInput,
  ) => Effect.Effect<CcswapStateSnapshot, CcswapOperationError>;
  readonly syncT3Instances: (
    input?: CcswapSyncT3Input,
  ) => Effect.Effect<CcswapSyncT3Result, CcswapOperationError>;
  readonly runAutoCheck: (
    input?: CcswapRunAutoInput,
  ) => Effect.Effect<CcswapRunAutoResult, CcswapOperationError>;
  readonly resolveTurnInstance: (input: {
    readonly instanceId: ProviderInstanceId;
    readonly model?: string | null;
  }) => Effect.Effect<ProviderInstanceId>;
}

export class CcswapService extends Context.Service<CcswapService, CcswapServiceShape>()(
  "t3/provider/CcswapService",
) {
  static readonly layer = Layer.effect(
    CcswapService,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const httpClient = yield* HttpClient.HttpClient;
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const providerRegistry = yield* ProviderRegistry;
      const home = yield* HostProcess.HomeDirectory;
      const env = yield* HostProcess.Environment;

      const provideEnv = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.provideService(HttpClient.HttpClient, httpClient),
        );

      const storeSemaphore = Semaphore.makeUnsafe(1);
      const lastAutoMessageRef = yield* Ref.make<string | null>(null);

      const resolvePaths = () => {
        const configHome = asString(env["CLAUDE_CONFIG_DIR"])
          ? path.resolve(env["CLAUDE_CONFIG_DIR"]!)
          : path.join(home, ".claude");
        const globalConfigFile = asString(env["CLAUDE_CONFIG_DIR"])
          ? path.join(configHome, ".claude.json")
          : path.join(home, ".claude.json");
        const credentialsFile = path.join(configHome, ".credentials.json");
        const ccswapRoot = asString(env["CCSWAP_HOME"])
          ? path.resolve(env["CCSWAP_HOME"]!)
          : path.join(
              asString(env["XDG_DATA_HOME"]) ?? path.join(home, ".local", "share"),
              "ccswap",
            );
        return {
          configHome,
          globalConfigFile,
          credentialsFile,
          ccswapRoot,
          slotsDir: path.join(ccswapRoot, "slots"),
          homesDir: path.join(ccswapRoot, "homes"),
          stateFile: path.join(ccswapRoot, "state.json"),
          profilesFile: path.join(ccswapRoot, "profiles.json"),
          usageFile: path.join(ccswapRoot, "usage.json"),
          slotFile: (num: number) => path.join(ccswapRoot, "slots", `${num}.json`),
          slotHomeDir: (num: number) => path.join(ccswapRoot, "homes", `slot-${num}`),
        };
      };

      const loadSlots = Effect.fn("CcswapService.loadSlots")(function* () {
        const paths = resolvePaths();
        const exists = yield* fs.exists(paths.slotsDir).pipe(Effect.orElseSucceed(() => false));
        const out = new Map<number, StoredSlot>();
        if (!exists) return out;
        const entries = yield* fs
          .readDirectory(paths.slotsDir)
          .pipe(Effect.orElseSucceed(() => []));
        const nums = entries
          .filter((name) => name.endsWith(".json"))
          .map((name) => Number.parseInt(name.slice(0, -5), 10))
          .filter((n) => Number.isInteger(n) && n >= 1 && n <= MAX_SLOTS)
          .sort((a, b) => a - b);

        for (const num of nums) {
          const rec = yield* readJsonRecord(paths.slotFile(num));
          if (Object.keys(rec).length === 0) continue;
          out.set(num, {
            email: asString(rec["email"]),
            alias: asString(rec["alias"]) ?? null,
            credentials: asRecord(rec["credentials"]),
            account: asRecord(rec["account"]),
            added_at: asString(rec["added_at"]),
          });
        }
        return out;
      });

      const saveSlot = Effect.fn("CcswapService.saveSlot")(function* (
        num: number,
        slot: StoredSlot,
      ) {
        const paths = resolvePaths();
        yield* fs.makeDirectory(paths.ccswapRoot, { recursive: true });
        yield* fs.chmod(paths.ccswapRoot, 0o700).pipe(Effect.ignore());
        yield* fs.makeDirectory(paths.slotsDir, { recursive: true });
        yield* fs.chmod(paths.slotsDir, 0o700).pipe(Effect.ignore());
        yield* writeJsonRecordAtomic(
          paths.slotFile(num),
          {
            email: slot.email ?? slotEmail(slot),
            ...(slot.alias ? { alias: slot.alias } : {}),
            credentials: slot.credentials,
            account: slot.account,
            ...(slot.added_at ? { added_at: slot.added_at } : {}),
          },
          0o600,
        );
      });

      const loadProfiles = Effect.fn("CcswapService.loadProfiles")(function* () {
        const paths = resolvePaths();
        const raw = yield* readJsonRecord(paths.profilesFile);
        const out = new Map<string, number[]>();
        for (const [name, nums] of Object.entries(raw)) {
          if (!Array.isArray(nums)) continue;
          out.set(
            name,
            nums
              .map((n) => (typeof n === "number" ? n : Number.parseInt(String(n), 10)))
              .filter((n) => Number.isInteger(n) && n >= 1 && n <= MAX_SLOTS),
          );
        }
        return out;
      });

      const saveProfiles = Effect.fn("CcswapService.saveProfiles")(function* (
        profiles: Map<string, number[]>,
      ) {
        const paths = resolvePaths();
        const obj: JsonRecord = {};
        for (const [name, nums] of profiles.entries()) {
          obj[name] = nums;
        }
        yield* writeJsonRecordAtomic(paths.profilesFile, obj, 0o600);
      });

      const loadState = Effect.fn("CcswapService.loadState")(function* () {
        const paths = resolvePaths();
        return yield* readJsonRecord(paths.stateFile);
      });

      const saveState = Effect.fn("CcswapService.saveState")(function* (state: JsonRecord) {
        const paths = resolvePaths();
        yield* fs.makeDirectory(paths.ccswapRoot, { recursive: true });
        yield* fs.chmod(paths.ccswapRoot, 0o700).pipe(Effect.ignore());
        yield* writeJsonRecordAtomic(paths.stateFile, state, 0o600);
      });

      const readGlobalActive = Effect.fn("CcswapService.readGlobalActive")(function* () {
        const paths = resolvePaths();
        const creds = yield* readJsonRecord(paths.credentialsFile);
        const cfg = yield* readJsonRecord(paths.globalConfigFile);
        return {
          oauth: asRecord(creds["claudeAiOauth"]),
          account: asRecord(cfg["oauthAccount"]),
        };
      });

      const installGlobalActive = Effect.fn("CcswapService.installGlobalActive")(function* (
        oauth: JsonRecord,
        account: JsonRecord,
      ) {
        const paths = resolvePaths();
        yield* withClaudeDirLocks(
          paths.configHome,
          paths.globalConfigFile,
          Effect.gen(function* () {
            const creds = yield* readJsonRecord(paths.credentialsFile);
            creds["claudeAiOauth"] = oauth;
            yield* writeJsonRecordAtomic(paths.credentialsFile, creds, 0o600);

            if (Object.keys(account).length > 0) {
              const cfg = yield* readJsonRecord(paths.globalConfigFile);
              cfg["oauthAccount"] = account;
              yield* writeJsonRecordAtomic(paths.globalConfigFile, cfg, 0o600);
            }
          }),
        );
      });

      const findActiveSlot = (
        slots: Map<number, StoredSlot>,
        oauth: JsonRecord,
        account: JsonRecord,
      ): number | null => {
        const email = asString(account["emailAddress"]);
        if (email) {
          for (const [num, slot] of slots.entries()) {
            if (slotEmail(slot).toLowerCase() === email.toLowerCase()) return num;
          }
        }
        const fp = tokenFingerprint(oauth);
        if (fp) {
          for (const [num, slot] of slots.entries()) {
            if (tokenFingerprint(slot.credentials) === fp) return num;
          }
        }
        return null;
      };

      const syncLiveTokensIntoSlots = Effect.fn("CcswapService.syncLiveTokensIntoSlots")(function* (
        slots: Map<number, StoredSlot>,
      ) {
        const paths = resolvePaths();
        const { oauth: globalOauth, account: globalAccount } = yield* readGlobalActive();
        const globalSlot = findActiveSlot(slots, globalOauth, globalAccount);
        if (globalSlot !== null && Object.keys(globalOauth).length > 0) {
          const slot = slots.get(globalSlot)!;
          const diskExp = asNumber(globalOauth["expiresAt"]) ?? 0;
          const slotExp = asNumber(slot.credentials["expiresAt"]) ?? 0;
          if (
            diskExp > slotExp ||
            tokenFingerprint(globalOauth) !== tokenFingerprint(slot.credentials)
          ) {
            const updated: StoredSlot = {
              ...slot,
              credentials: globalOauth,
              ...(Object.keys(globalAccount).length > 0 ? { account: globalAccount } : {}),
            };
            slots.set(globalSlot, updated);
            yield* saveSlot(globalSlot, updated);
          }
        }

        for (const [num, slot] of slots.entries()) {
          const shadowCreds = path.join(paths.slotHomeDir(num), ".credentials.json");
          const exists = yield* fs.exists(shadowCreds).pipe(Effect.orElseSucceed(() => false));
          if (!exists) continue;
          const raw = yield* readJsonRecord(shadowCreds);
          const shadowOauth = asRecord(raw["claudeAiOauth"]);
          if (Object.keys(shadowOauth).length === 0) continue;
          const diskExp = asNumber(shadowOauth["expiresAt"]) ?? 0;
          const slotExp = asNumber(slot.credentials["expiresAt"]) ?? 0;
          if (diskExp > slotExp) {
            const updated: StoredSlot = { ...slot, credentials: shadowOauth };
            slots.set(num, updated);
            yield* saveSlot(num, updated);
          }
        }
      });

      const refreshOauthToken = Effect.fn("CcswapService.refreshOauthToken")(function* (
        oauth: JsonRecord,
      ) {
        const refresh = asString(oauth["refreshToken"]);
        if (!refresh) {
          return { oauth: null as JsonRecord | null, error: "missing refreshToken" };
        }
        const request = HttpClientRequest.post(OAUTH_TOKEN_URL).pipe(
          HttpClientRequest.bodyJsonUnsafe({
            grant_type: "refresh_token",
            refresh_token: refresh,
            client_id: CLIENT_ID,
            scope: SCOPES,
          }),
          HttpClientRequest.setHeader("content-type", "application/json"),
        );
        const result = yield* httpClient.execute(request).pipe(
          Effect.flatMap(
            Effect.fnUntraced(function* (res) {
              if (res.status >= 200 && res.status < 300) {
                const body = yield* res.json;
                return { ok: true as const, body: asRecord(body) };
              }
              const text = yield* res.text;
              return { ok: false as const, status: res.status, text };
            }),
          ),
          Effect.timeout("10 seconds"),
          Effect.orElseSucceed(() => ({
            ok: false as const,
            status: 0,
            text: "network or timeout error",
          })),
        );
        if (!result.ok) {
          return {
            oauth: null,
            error: `HTTP ${result.status || "error"}: ${result.text.slice(0, 140)}`,
          };
        }
        const newAccess = asString(result.body["access_token"]);
        if (!newAccess) {
          return { oauth: null, error: "empty access_token in refresh response" };
        }
        const expiresIn = asNumber(result.body["expires_in"]) ?? 28800;
        const nowMs = yield* Clock.currentTimeMillis;
        const updated: JsonRecord = {
          ...oauth,
          accessToken: newAccess,
          refreshToken: asString(result.body["refresh_token"]) ?? refresh,
          expiresAt: nowMs + expiresIn * 1000,
        };
        return { oauth: updated, error: "" };
      });

      const readUsageForAccount = Effect.fn("CcswapService.readUsageForAccount")(function* (input: {
        readonly email: string;
        readonly accessToken: string;
        readonly forceRefresh: boolean;
      }) {
        const paths = resolvePaths();
        const nowMs = yield* Clock.currentTimeMillis;
        const now = nowMs / 1000;
        const cache = yield* readJsonRecord(paths.usageFile);
        const entry = readStoredUsageEntry(cache[input.email]);
        const fetchedAt = entry.at ?? 0;
        const cachedUsage = entry.usage ?? null;
        const rateLimitedUntil = entry.blocked_until ?? 0;

        if (!input.forceRefresh && cachedUsage && now - fetchedAt < USAGE_CACHE_TTL_S) {
          return {
            usage: cachedUsage,
            checkedAt: Math.round(fetchedAt * 1000),
            stale: false,
            error: null as string | null,
          };
        }
        if (now < rateLimitedUntil) {
          const wait = Math.max(1, Math.round(rateLimitedUntil - now));
          if (cachedUsage && now - fetchedAt < USAGE_STALE_MAX_S) {
            return {
              usage: cachedUsage,
              checkedAt: Math.round(fetchedAt * 1000),
              stale: true,
              error: `rate limited (429, retry in ${wait}s)`,
            };
          }
          return {
            usage: null,
            checkedAt: null,
            stale: false,
            error: `HTTP 429 (retry in ${wait}s)`,
          };
        }
        if (!input.accessToken) {
          return { usage: null, checkedAt: null, stale: false, error: "missing accessToken" };
        }

        const request = HttpClientRequest.get(USAGE_URL).pipe(
          HttpClientRequest.setHeaders({
            authorization: `Bearer ${input.accessToken}`,
            "anthropic-beta": "oauth-2025-04-20",
            accept: "application/json",
            "user-agent": "claude-code/2.1.0",
          }),
        );
        const response = yield* httpClient.execute(request).pipe(
          Effect.flatMap(
            Effect.fnUntraced(function* (res) {
              if (res.status >= 200 && res.status < 300) {
                const body = yield* res.json;
                return { ok: true as const, body: asRecord(body) };
              }
              return {
                ok: false as const,
                status: res.status,
                retryAfter: res.headers["retry-after"],
              };
            }),
          ),
          Effect.timeout("8 seconds"),
          Effect.orElseSucceed(() => ({ ok: false as const, status: 0, retryAfter: undefined })),
        );

        const nextCache = yield* readJsonRecord(paths.usageFile);
        if (response.ok) {
          const parsed = parseUsagePayload(response.body);
          const fresh: StoredUsageEntry = { usage: parsed, at: now };
          nextCache[input.email] = fresh;
          yield* fs.makeDirectory(paths.ccswapRoot, { recursive: true });
          yield* writeJsonRecordAtomic(paths.usageFile, nextCache, 0o600);
          return {
            usage: parsed,
            checkedAt: Math.round(now * 1000),
            stale: false,
            error: null,
          };
        }

        if (response.status === 429) {
          const strikes = (entry.strikes ?? 0) + 1;
          const parsedRetry = response.retryAfter ? Number.parseFloat(response.retryAfter) : 0;
          const retryS = Math.max(
            Number.isFinite(parsedRetry) && parsedRetry > 0 ? parsedRetry : 0,
            Math.min(USAGE_CACHE_TTL_S * Math.pow(2, strikes - 1), USAGE_STALE_MAX_S),
          );
          const blocked: StoredUsageEntry = {
            ...readStoredUsageEntry(nextCache[input.email]),
            blocked_until: now + retryS,
            error: "HTTP 429",
            strikes,
          };
          nextCache[input.email] = blocked;
          yield* fs.makeDirectory(paths.ccswapRoot, { recursive: true });
          yield* writeJsonRecordAtomic(paths.usageFile, nextCache, 0o600);
          if (cachedUsage && now - fetchedAt < USAGE_STALE_MAX_S) {
            return {
              usage: cachedUsage,
              checkedAt: Math.round(fetchedAt * 1000),
              stale: true,
              error: `rate limited (429, retry in ${Math.round(retryS)}s)`,
            };
          }
          return {
            usage: null,
            checkedAt: null,
            stale: false,
            error: `HTTP 429 (retry in ${Math.round(retryS)}s)`,
          };
        }

        const errMsg = response.status ? `HTTP ${response.status}` : "network error";
        if (cachedUsage && now - fetchedAt < USAGE_STALE_MAX_S) {
          return {
            usage: cachedUsage,
            checkedAt: Math.round(fetchedAt * 1000),
            stale: true,
            error: errMsg,
          };
        }
        return { usage: null, checkedAt: null, stale: false, error: errMsg };
      });

      const usageForSlot = Effect.fn("CcswapService.usageForSlot")(function* (input: {
        readonly slotNum: number;
        readonly slot: StoredSlot;
        readonly slots: Map<number, StoredSlot>;
        readonly isGlobalActive: boolean;
        readonly forceRefresh: boolean;
      }) {
        const nowMs = yield* Clock.currentTimeMillis;
        let oauth = input.slot.credentials;
        let tokenError: string | null = null;
        if (!input.isGlobalActive && isTokenExpired(oauth, nowMs)) {
          const refreshed = yield* refreshOauthToken(oauth);
          if (refreshed.oauth) {
            oauth = refreshed.oauth;
            const updated: StoredSlot = { ...input.slot, credentials: oauth };
            input.slots.set(input.slotNum, updated);
            yield* saveSlot(input.slotNum, updated);
          } else {
            tokenError = refreshed.error;
          }
        }
        if (tokenError && isTokenExpired(oauth, nowMs, 0)) {
          return {
            rawUsage: null as JsonRecord | null,
            contractUsage: toContractUsage(null, null, false, `token expired (${tokenError})`),
          };
        }
        const accessToken = asString(oauth["accessToken"]) ?? "";
        const res = yield* readUsageForAccount({
          email: slotEmail(input.slot),
          accessToken,
          forceRefresh: input.forceRefresh,
        });
        return {
          rawUsage: res.usage,
          contractUsage: toContractUsage(res.usage, res.checkedAt, res.stale, res.error),
        };
      });

      const resolveScopedSlots = (
        slots: Map<number, StoredSlot>,
        profiles: Map<string, number[]>,
        activeProfile: string | null,
      ): Map<number, StoredSlot> => {
        if (!activeProfile || !profiles.has(activeProfile)) return slots;
        const members = new Set(profiles.get(activeProfile)!);
        const scoped = new Map<number, StoredSlot>();
        for (const [num, slot] of slots.entries()) {
          if (members.has(num)) scoped.set(num, slot);
        }
        return scoped;
      };

      const buildSnapshot = Effect.fn("CcswapService.buildSnapshot")(function* (input: {
        readonly fetchUsage: boolean;
        readonly forceRefreshUsage: boolean;
      }): Effect.fn.Return<
        CcswapStateSnapshot,
        CcswapOperationError,
        FileSystem.FileSystem | Path.Path | HttpClient.HttpClient
      > {
        const paths = resolvePaths();
        const nowMs = yield* Clock.currentTimeMillis;
        const slots = yield* loadSlots().pipe(Effect.mapError(mapOpError));
        yield* syncLiveTokensIntoSlots(slots).pipe(Effect.mapError(mapOpError));
        const profilesMap = yield* loadProfiles().pipe(Effect.mapError(mapOpError));
        const state = yield* loadState().pipe(Effect.mapError(mapOpError));
        const { oauth: globalOauth, account: globalAccount } = yield* readGlobalActive().pipe(
          Effect.mapError(mapOpError),
        );
        const globalActiveSlot = findActiveSlot(slots, globalOauth, globalAccount);
        const globalActiveEmail =
          asString(globalAccount["emailAddress"]) ??
          (globalActiveSlot !== null ? slotEmail(slots.get(globalActiveSlot)!) : null);

        const activeProfileName = asString(state["profile"]);
        const activeProfile =
          activeProfileName && profilesMap.has(activeProfileName) ? activeProfileName : null;
        const scoped = resolveScopedSlots(slots, profilesMap, activeProfile);

        const settings = yield* serverSettings.getSettings.pipe(Effect.mapError(mapOpError));
        const autoConfig: CcswapAutoSettings = settings.ccswapAuto;
        const instances = settings.providerInstances;

        let globalConflictWithT3Instance: ProviderInstanceId | null = null;
        const defaultClaudeInstance = instances[ProviderInstanceId.make("claudeAgent")];
        const defaultHome = asString(asRecord(defaultClaudeInstance?.config)["homePath"]);
        if (slots.size > 1 && (!defaultClaudeInstance || !defaultHome)) {
          globalConflictWithT3Instance = ProviderInstanceId.make("claudeAgent");
        }

        const slotEntries: CcswapAccountSlot[] = [];
        for (const [num, slot] of slots.entries()) {
          const isGlobalActive = num === globalActiveSlot;
          const id = slotInstanceId(num);
          const instanceCfg = instances[id];
          const t3HomePath =
            instanceCfg && instanceCfg.driver === "claudeAgent"
              ? (asString(asRecord(instanceCfg.config)["homePath"]) ?? null)
              : null;

          let contractUsage: CcswapSlotUsage | null = null;
          if (input.fetchUsage) {
            const res = yield* usageForSlot({
              slotNum: num,
              slot,
              slots,
              isGlobalActive,
              forceRefresh: input.forceRefreshUsage,
            }).pipe(Effect.mapError(mapOpError));
            contractUsage = res.contractUsage;
          } else {
            const cache = yield* readJsonRecord(paths.usageFile).pipe(Effect.mapError(mapOpError));
            const entry = readStoredUsageEntry(cache[slotEmail(slot)]);
            const cachedUsage = entry.usage ?? null;
            const fetchedAt = entry.at;
            if (cachedUsage) {
              contractUsage = toContractUsage(
                cachedUsage,
                fetchedAt !== undefined ? Math.round(fetchedAt * 1000) : null,
                nowMs / 1000 - (fetchedAt ?? 0) >= USAGE_CACHE_TTL_S,
                null,
              );
            }
          }

          slotEntries.push({
            slot: num,
            email: slotEmail(slot),
            alias: slot.alias ?? null,
            plan: slotPlan(slot),
            isGlobalActive,
            inActiveProfile: scoped.has(num),
            tokenValid:
              !isTokenExpired(slot.credentials, nowMs, 0) ||
              Boolean(asString(slot.credentials["refreshToken"])),
            tokenExpiresAt: asNumber(slot.credentials["expiresAt"]) ?? null,
            t3InstanceId: instanceCfg && instanceCfg.driver === "claudeAgent" ? id : null,
            t3HomePath,
            usage: contractUsage,
          });
        }

        const profiles: CcswapProfile[] = Array.from(profilesMap.entries()).map(([name, nums]) => ({
          name,
          slots: nums,
          active: name === activeProfile,
        }));

        const lastSwitchSec = asNumber(state["last_switch"]);
        const lastAutoMessage = yield* Ref.get(lastAutoMessageRef);

        return {
          globalActiveEmail,
          globalActiveSlot,
          globalConflictWithT3Instance,
          activeProfile,
          profiles,
          slots: slotEntries,
          lastSwitchAt: lastSwitchSec !== undefined ? Math.round(lastSwitchSec * 1000) : null,
          lastAutoMessage,
          autoConfig,
        };
      });

      const doSwitch = Effect.fn("CcswapService.doSwitch")(function* (
        targetNum: number,
        slots: Map<number, StoredSlot>,
        reason: string,
      ) {
        const target = slots.get(targetNum);
        if (!target) {
          return yield* new CcswapOperationError({
            message: `Slot ${targetNum} not found`,
          });
        }
        const paths = resolvePaths();
        const { oauth: globalOauth, account: globalAccount } = yield* readGlobalActive().pipe(
          Effect.mapError(mapOpError),
        );
        const active = findActiveSlot(slots, globalOauth, globalAccount);
        if (active !== null && Object.keys(globalOauth).length > 0) {
          const activeSlot = slots.get(active)!;
          const updatedActive: StoredSlot = {
            ...activeSlot,
            credentials: globalOauth,
            ...(Object.keys(globalAccount).length > 0 ? { account: globalAccount } : {}),
          };
          slots.set(active, updatedActive);
          yield* saveSlot(active, updatedActive).pipe(Effect.mapError(mapOpError));
        }

        yield* installGlobalActive(target.credentials, target.account).pipe(
          Effect.mapError(mapOpError),
        );
        const state = yield* loadState().pipe(Effect.mapError(mapOpError));
        const nowMs = yield* Clock.currentTimeMillis;
        state["active"] = targetNum;
        state["last_switch"] = nowMs / 1000;
        state["last_reason"] = reason;
        yield* saveState(state).pipe(Effect.mapError(mapOpError));

        const shadowDir = paths.slotHomeDir(targetNum);
        const shadowExists = yield* fs.exists(shadowDir).pipe(Effect.orElseSucceed(() => false));
        if (shadowExists) {
          yield* ensureClaudeShadowHome({
            sharedClaudeDir: paths.configHome,
            shadowHomeDir: shadowDir,
            globalConfigFile: paths.globalConfigFile,
            oauth: target.credentials,
            account: target.account,
          }).pipe(Effect.ignore());
        }
      });

      const leastUsedSlot = Effect.fn("CcswapService.leastUsedSlot")(function* (input: {
        readonly candidates: Map<number, StoredSlot>;
        readonly allSlots: Map<number, StoredSlot>;
        readonly globalActiveSlot: number | null;
        readonly models: ReadonlyArray<string>;
      }) {
        let bestNum: number | null = null;
        let bestPct = Number.POSITIVE_INFINITY;
        for (const [num, slot] of input.candidates.entries()) {
          const { rawUsage } = yield* usageForSlot({
            slotNum: num,
            slot,
            slots: input.allSlots,
            isGlobalActive: num === input.globalActiveSlot,
            forceRefresh: false,
          }).pipe(Effect.mapError(mapOpError));
          const pct = worstPct(rawUsage, input.models);
          if (pct !== null && pct < bestPct) {
            bestPct = pct;
            bestNum = num;
          }
        }
        return bestNum;
      });

      const syncT3InstancesImpl = Effect.fn("CcswapService.syncT3InstancesImpl")(function* (
        input?: CcswapSyncT3Input,
      ) {
        const paths = resolvePaths();
        const slots = yield* loadSlots().pipe(Effect.mapError(mapOpError));
        yield* syncLiveTokensIntoSlots(slots).pipe(Effect.mapError(mapOpError));

        const settings = yield* serverSettings.getSettings.pipe(Effect.mapError(mapOpError));
        const nextInstances: Record<string, ProviderInstanceConfig> = {
          ...settings.providerInstances,
        };
        const syncedInstances: ProviderInstanceId[] = [];

        const targetSlotNums = input?.slot !== undefined ? [input.slot] : Array.from(slots.keys());

        for (const num of targetSlotNums) {
          const slot = slots.get(num);
          if (!slot) {
            return yield* new CcswapOperationError({ message: `Slot ${num} not found` });
          }
          const shadowDir = paths.slotHomeDir(num);
          yield* ensureClaudeShadowHome({
            sharedClaudeDir: paths.configHome,
            shadowHomeDir: shadowDir,
            globalConfigFile: paths.globalConfigFile,
            oauth: slot.credentials,
            account: slot.account,
          }).pipe(Effect.mapError(mapOpError));
          const id = slotInstanceId(num);
          const existing = nextInstances[id];
          const existingConfig = existing ? asRecord(existing.config) : {};
          nextInstances[id] = {
            driver: ProviderDriverKind.make("claudeAgent"),
            displayName: slot.alias?.trim() || slotEmail(slot),
            enabled: existing?.enabled ?? true,
            ...(existing?.accentColor ? { accentColor: existing.accentColor } : {}),
            config: {
              ...existingConfig,
              homePath: shadowDir,
            },
          };
          syncedInstances.push(id);
        }

        if (input?.slot === undefined) {
          for (const key of Object.keys(nextInstances)) {
            const parsedSlot = parseCcswapSlotFromInstanceId(key);
            if (parsedSlot !== null && !slots.has(parsedSlot)) {
              delete nextInstances[key];
            }
          }
        }

        yield* serverSettings
          .updateSettings({
            providerInstances: nextInstances as Record<ProviderInstanceId, ProviderInstanceConfig>,
          })
          .pipe(Effect.mapError(mapOpError));

        yield* providerRegistry.refresh().pipe(Effect.ignore());
        const snapshot = yield* buildSnapshot({ fetchUsage: false, forceRefreshUsage: false });
        return { state: snapshot, syncedInstances };
      });

      const runAutoCheckImpl = Effect.fn("CcswapService.runAutoCheckImpl")(function* (
        input?: CcswapRunAutoInput,
      ): Effect.fn.Return<
        CcswapRunAutoResult,
        CcswapOperationError,
        FileSystem.FileSystem | Path.Path | HttpClient.HttpClient
      > {
        const dryRun = input?.dryRun === true;
        const nowMs = yield* Clock.currentTimeMillis;
        const slots = yield* loadSlots().pipe(Effect.mapError(mapOpError));
        yield* syncLiveTokensIntoSlots(slots).pipe(Effect.mapError(mapOpError));
        if (slots.size < 2) {
          const msg = "Need at least 2 accounts in ccswap for auto-switch.";
          yield* Ref.set(lastAutoMessageRef, msg);
          return {
            state: yield* buildSnapshot({ fetchUsage: false, forceRefreshUsage: false }),
            outcome: "error",
            message: msg,
          };
        }

        const { oauth: globalOauth, account: globalAccount } = yield* readGlobalActive().pipe(
          Effect.mapError(mapOpError),
        );
        const active = findActiveSlot(slots, globalOauth, globalAccount);
        if (active === null) {
          const msg = "Active global Claude login does not match any ccswap slot.";
          yield* Ref.set(lastAutoMessageRef, msg);
          return {
            state: yield* buildSnapshot({ fetchUsage: false, forceRefreshUsage: false }),
            outcome: "error",
            message: msg,
          };
        }

        const settings = yield* serverSettings.getSettings.pipe(Effect.mapError(mapOpError));
        const auto = settings.ccswapAuto;
        const models = auto.modelFilter
          .split(",")
          .map((m) => m.trim())
          .filter(Boolean);

        const activeSlot = slots.get(active)!;
        const activeEmail = slotEmail(activeSlot);
        const activeRes = yield* usageForSlot({
          slotNum: active,
          slot: activeSlot,
          slots,
          isGlobalActive: true,
          forceRefresh: false,
        }).pipe(Effect.mapError(mapOpError));
        const activeWorst = worstWindow(activeRes.rawUsage, models);
        if (!activeWorst) {
          const msg = `${activeEmail}: usage unavailable; keeping current account.`;
          yield* Ref.set(lastAutoMessageRef, msg);
          return {
            state: yield* buildSnapshot({ fetchUsage: false, forceRefreshUsage: false }),
            outcome: "noop",
            message: msg,
          };
        }

        if (activeWorst.pct < auto.threshold) {
          const msg = `${activeEmail}: ${activeWorst.name} at ${activeWorst.pct.toFixed(1)}% (< ${auto.threshold}%); ok.`;
          yield* Ref.set(lastAutoMessageRef, msg);
          return {
            state: yield* buildSnapshot({ fetchUsage: false, forceRefreshUsage: false }),
            outcome: "noop",
            message: msg,
          };
        }

        const state = yield* loadState().pipe(Effect.mapError(mapOpError));
        const lastSwitch = asNumber(state["last_switch"]);
        const since = lastSwitch == null ? Number.POSITIVE_INFINITY : nowMs / 1000 - lastSwitch;
        if (since < auto.cooldownSeconds) {
          const wait = Math.ceil(auto.cooldownSeconds - since);
          const msg = `${activeEmail}: ${activeWorst.name} at ${activeWorst.pct.toFixed(1)}%; in cooldown (${wait}s left).`;
          yield* Ref.set(lastAutoMessageRef, msg);
          return {
            state: yield* buildSnapshot({ fetchUsage: false, forceRefreshUsage: false }),
            outcome: "noop",
            message: msg,
          };
        }

        const profilesMap = yield* loadProfiles().pipe(Effect.mapError(mapOpError));
        const activeProfileName = asString(state["profile"]);
        const activeProfile =
          activeProfileName && profilesMap.has(activeProfileName) ? activeProfileName : null;
        const scoped = resolveScopedSlots(slots, profilesMap, activeProfile);

        let bestSlot: number | null = null;
        let bestPct = Number.POSITIVE_INFINITY;
        const othersUsage = new Map<number, JsonRecord | null>();

        for (const [num, slot] of scoped.entries()) {
          if (num === active) continue;
          const res = yield* usageForSlot({
            slotNum: num,
            slot,
            slots,
            isGlobalActive: false,
            forceRefresh: false,
          }).pipe(Effect.mapError(mapOpError));
          othersUsage.set(num, res.rawUsage);
          const cand = worstWindow(res.rawUsage, models);
          if (!cand) continue;
          if (
            cand.pct < auto.threshold &&
            cand.pct <= activeWorst.pct - auto.margin &&
            cand.pct < bestPct
          ) {
            bestSlot = num;
            bestPct = cand.pct;
          }
        }

        if (bestSlot !== null) {
          const targetEmail = slotEmail(slots.get(bestSlot)!);
          if (!dryRun) {
            yield* doSwitch(
              bestSlot,
              slots,
              `${activeEmail} ${activeWorst.name} at ${activeWorst.pct.toFixed(1)}%`,
            );
          }
          const msg = dryRun
            ? `[dry-run] Would switch to ${targetEmail} (${bestPct.toFixed(1)}%).`
            : `Switched to ${targetEmail} (${bestPct.toFixed(1)}%); ${activeEmail} reached ${activeWorst.pct.toFixed(1)}%.`;
          yield* Ref.set(lastAutoMessageRef, msg);
          return {
            state: yield* buildSnapshot({ fetchUsage: false, forceRefreshUsage: false }),
            outcome: "switched",
            message: msg,
            switchedToSlot: bestSlot,
          };
        }

        if (activeWorst.pct < HARD_LIMIT) {
          const msg = `${activeEmail}: ${activeWorst.name} at ${activeWorst.pct.toFixed(1)}%; no better alternative below ${auto.threshold}%, keeping active quota.`;
          yield* Ref.set(lastAutoMessageRef, msg);
          return {
            state: yield* buildSnapshot({ fetchUsage: false, forceRefreshUsage: false }),
            outcome: "blocked",
            message: msg,
          };
        }

        let usableTarget: number | null = null;
        let usablePct = Number.POSITIVE_INFINITY;
        for (const [num, raw] of othersUsage.entries()) {
          const p = worstPct(raw, models);
          if (p !== null && p < HARD_LIMIT && p < usablePct) {
            usableTarget = num;
            usablePct = p;
          }
        }
        if (usableTarget !== null) {
          const targetEmail = slotEmail(slots.get(usableTarget)!);
          if (!dryRun) {
            yield* doSwitch(
              usableTarget,
              slots,
              `${activeEmail} exhausted; ${targetEmail} still has quota (${usablePct.toFixed(1)}%)`,
            );
          }
          const msg = dryRun
            ? `[dry-run] Active exhausted; would switch to ${targetEmail} (${usablePct.toFixed(1)}%).`
            : `Active exhausted; switched to ${targetEmail} (${usablePct.toFixed(1)}%).`;
          yield* Ref.set(lastAutoMessageRef, msg);
          return {
            state: yield* buildSnapshot({ fetchUsage: false, forceRefreshUsage: false }),
            outcome: "switched",
            message: msg,
            switchedToSlot: usableTarget,
          };
        }

        const myRelease = availableAt(activeRes.rawUsage, models, HARD_LIMIT);
        let soonestTarget: number | null = null;
        let soonestMs = Number.POSITIVE_INFINITY;
        for (const [num, raw] of othersUsage.entries()) {
          const when = availableAt(raw, models, HARD_LIMIT);
          if (when !== null && when < soonestMs) {
            soonestMs = when;
            soonestTarget = num;
          }
        }
        if (soonestTarget === null || (myRelease !== null && myRelease <= soonestMs)) {
          const msg =
            "All accounts at 100%; active account resets soonest (or no alternative known).";
          yield* Ref.set(lastAutoMessageRef, msg);
          return {
            state: yield* buildSnapshot({ fetchUsage: false, forceRefreshUsage: false }),
            outcome: "blocked",
            message: msg,
          };
        }

        const soonestEmail = slotEmail(slots.get(soonestTarget)!);
        const whenStr = DateTime.formatLocal(DateTime.makeUnsafe(soonestMs));
        if (!dryRun) {
          yield* doSwitch(soonestTarget, slots, `all exhausted; resets soonest (${whenStr})`);
        }
        const msg = dryRun
          ? `[dry-run] All exhausted; would switch to ${soonestEmail} (resets ${whenStr}).`
          : `All exhausted; switched to ${soonestEmail} (resets soonest at ${whenStr}).`;
        yield* Ref.set(lastAutoMessageRef, msg);
        return {
          state: yield* buildSnapshot({ fetchUsage: false, forceRefreshUsage: false }),
          outcome: "switched",
          message: msg,
          switchedToSlot: soonestTarget,
        };
      });

      const autoLoop = Effect.forever(
        Effect.gen(function* () {
          const settings = yield* serverSettings.getSettings.pipe(Effect.orElseSucceed(() => null));
          const intervalS = Math.max(15, settings?.ccswapAuto.intervalSeconds ?? 60);
          yield* Effect.sleep(`${intervalS} seconds`);
          const latest = yield* serverSettings.getSettings.pipe(Effect.orElseSucceed(() => null));
          if (!latest?.ccswapAuto.enabled) return;
          yield* storeSemaphore
            .withPermits(1)(runAutoCheckImpl({ dryRun: false }))
            .pipe(Effect.ignore());
        }),
      );
      yield* Effect.forkScoped(provideEnv(autoLoop));

      return {
        getState: Effect.fn("CcswapService.getState")(function* (input) {
          return yield* provideEnv(
            storeSemaphore.withPermits(1)(
              buildSnapshot({
                fetchUsage: true,
                forceRefreshUsage: input?.refreshUsage === true,
              }),
            ),
          );
        }),

        addActive: Effect.fn("CcswapService.addActive")(function* (input) {
          return yield* provideEnv(
            storeSemaphore.withPermits(1)(
              Effect.gen(function* () {
                const { oauth, account } = yield* readGlobalActive().pipe(
                  Effect.mapError(mapOpError),
                );
                if (Object.keys(oauth).length === 0) {
                  return yield* new CcswapOperationError({
                    message: "No active Claude login found in ~/.claude/.credentials.json.",
                  });
                }
                const email = asString(account["emailAddress"]);
                if (!email) {
                  return yield* new CcswapOperationError({
                    message: "Active login has no emailAddress in ~/.claude.json.",
                  });
                }
                const slots = yield* loadSlots().pipe(Effect.mapError(mapOpError));
                const existingNum = findActiveSlot(slots, oauth, account);
                let targetNum: number;
                if (existingNum !== null) {
                  targetNum = existingNum;
                } else {
                  let nextFree = 1;
                  while (slots.has(nextFree) && nextFree <= MAX_SLOTS) nextFree += 1;
                  if (nextFree > MAX_SLOTS) {
                    return yield* new CcswapOperationError({
                      message: "Maximum number of ccswap slots (99) reached.",
                    });
                  }
                  targetNum = nextFree;
                }
                const prev = slots.get(targetNum);
                const alias = input.alias?.trim() || prev?.alias || null;
                const nowDt = yield* DateTime.now;
                const nextSlot: StoredSlot = {
                  email,
                  alias,
                  credentials: oauth,
                  account,
                  added_at: prev?.added_at ?? DateTime.formatIso(nowDt),
                };
                yield* saveSlot(targetNum, nextSlot).pipe(Effect.mapError(mapOpError));
                return yield* buildSnapshot({ fetchUsage: true, forceRefreshUsage: false });
              }),
            ),
          );
        }),

        removeSlot: Effect.fn("CcswapService.removeSlot")(function* (input) {
          return yield* provideEnv(
            storeSemaphore.withPermits(1)(
              Effect.gen(function* () {
                const paths = resolvePaths();
                const slots = yield* loadSlots().pipe(Effect.mapError(mapOpError));
                if (!slots.has(input.slot)) {
                  return yield* new CcswapOperationError({
                    message: `Slot ${input.slot} not found.`,
                  });
                }
                yield* fs.remove(paths.slotFile(input.slot)).pipe(Effect.ignore());
                yield* fs
                  .remove(paths.slotHomeDir(input.slot), { recursive: true })
                  .pipe(Effect.ignore());

                const profiles = yield* loadProfiles().pipe(Effect.mapError(mapOpError));
                let profilesChanged = false;
                for (const [name, nums] of profiles.entries()) {
                  const filtered = nums.filter((n) => n !== input.slot);
                  if (filtered.length !== nums.length) {
                    profiles.set(name, filtered);
                    profilesChanged = true;
                  }
                }
                if (profilesChanged) {
                  yield* saveProfiles(profiles).pipe(Effect.mapError(mapOpError));
                }

                const id = slotInstanceId(input.slot);
                const settings = yield* serverSettings.getSettings.pipe(
                  Effect.mapError(mapOpError),
                );
                if (Object.hasOwn(settings.providerInstances, id)) {
                  const nextInstances = { ...settings.providerInstances };
                  delete nextInstances[id];
                  yield* serverSettings
                    .updateSettings({
                      providerInstances: nextInstances as Record<
                        ProviderInstanceId,
                        ProviderInstanceConfig
                      >,
                    })
                    .pipe(Effect.ignore());
                  yield* providerRegistry.refresh().pipe(Effect.ignore());
                }

                return yield* buildSnapshot({ fetchUsage: false, forceRefreshUsage: false });
              }),
            ),
          );
        }),

        setAlias: Effect.fn("CcswapService.setAlias")(function* (input) {
          return yield* provideEnv(
            storeSemaphore.withPermits(1)(
              Effect.gen(function* () {
                const slots = yield* loadSlots().pipe(Effect.mapError(mapOpError));
                const existing = slots.get(input.slot);
                if (!existing) {
                  return yield* new CcswapOperationError({
                    message: `Slot ${input.slot} not found.`,
                  });
                }
                const nextAlias = input.alias?.trim() || null;
                const updated: StoredSlot = { ...existing, alias: nextAlias };
                yield* saveSlot(input.slot, updated).pipe(Effect.mapError(mapOpError));

                const id = slotInstanceId(input.slot);
                const settings = yield* serverSettings.getSettings.pipe(
                  Effect.mapError(mapOpError),
                );
                const existingInstance = settings.providerInstances[id];
                if (existingInstance && existingInstance.driver === "claudeAgent") {
                  const nextInstances = {
                    ...settings.providerInstances,
                    [id]: {
                      ...existingInstance,
                      displayName: nextAlias ?? slotEmail(updated),
                    },
                  };
                  yield* serverSettings
                    .updateSettings({
                      providerInstances: nextInstances as Record<
                        ProviderInstanceId,
                        ProviderInstanceConfig
                      >,
                    })
                    .pipe(Effect.ignore());
                  yield* providerRegistry.refresh().pipe(Effect.ignore());
                }

                return yield* buildSnapshot({ fetchUsage: false, forceRefreshUsage: false });
              }),
            ),
          );
        }),

        switchAccount: Effect.fn("CcswapService.switchAccount")(function* (input) {
          return yield* provideEnv(
            storeSemaphore.withPermits(1)(
              Effect.gen(function* () {
                const slots = yield* loadSlots().pipe(Effect.mapError(mapOpError));
                if (slots.size === 0) {
                  return yield* new CcswapOperationError({
                    message: "No accounts configured in ccswap.",
                  });
                }
                yield* syncLiveTokensIntoSlots(slots).pipe(Effect.mapError(mapOpError));
                const { oauth, account } = yield* readGlobalActive().pipe(
                  Effect.mapError(mapOpError),
                );
                const active = findActiveSlot(slots, oauth, account);
                const profiles = yield* loadProfiles().pipe(Effect.mapError(mapOpError));
                const state = yield* loadState().pipe(Effect.mapError(mapOpError));
                const activeProfileName = asString(state["profile"]);
                const activeProfile =
                  activeProfileName && profiles.has(activeProfileName) ? activeProfileName : null;
                const scoped = resolveScopedSlots(slots, profiles, activeProfile);

                let targetNum: number;
                let reason: string;
                if (typeof input.target === "number") {
                  if (!slots.has(input.target)) {
                    return yield* new CcswapOperationError({
                      message: `Slot ${input.target} not found.`,
                    });
                  }
                  targetNum = input.target;
                  reason = "manual";
                } else if (input.target === "best") {
                  const candidates = new Map<number, StoredSlot>();
                  for (const [num, slot] of scoped.entries()) {
                    if (num !== active) candidates.set(num, slot);
                  }
                  const best = yield* leastUsedSlot({
                    candidates: candidates.size > 0 ? candidates : scoped,
                    allSlots: slots,
                    globalActiveSlot: active,
                    models: [],
                  });
                  if (best === null) {
                    return yield* new CcswapOperationError({
                      message: "Could not read usage for any candidate account.",
                    });
                  }
                  targetNum = best;
                  reason = "best";
                } else {
                  const order = Array.from(scoped.keys());
                  if (order.length === 0) {
                    return yield* new CcswapOperationError({
                      message: "Active profile has no accounts.",
                    });
                  }
                  if (active !== null && order.includes(active)) {
                    targetNum = order[(order.indexOf(active) + 1) % order.length]!;
                  } else {
                    targetNum = order[0]!;
                  }
                  reason = "next";
                }

                yield* doSwitch(targetNum, slots, reason);
                const snapshot = yield* buildSnapshot({
                  fetchUsage: false,
                  forceRefreshUsage: false,
                });
                return {
                  state: snapshot,
                  switchedToSlot: targetNum,
                  switchedToEmail: slotEmail(slots.get(targetNum)!),
                  reason,
                };
              }),
            ),
          );
        }),

        profileAction: Effect.fn("CcswapService.profileAction")(function* (input) {
          return yield* provideEnv(
            storeSemaphore.withPermits(1)(
              Effect.gen(function* () {
                const slots = yield* loadSlots().pipe(Effect.mapError(mapOpError));
                const profiles = yield* loadProfiles().pipe(Effect.mapError(mapOpError));
                const state = yield* loadState().pipe(Effect.mapError(mapOpError));

                if (input.action === "off") {
                  state["profile"] = null;
                  yield* saveState(state).pipe(Effect.mapError(mapOpError));
                  return yield* buildSnapshot({ fetchUsage: false, forceRefreshUsage: false });
                }

                if (input.action === "set") {
                  const validNums = Array.from(new Set(input.slots)).filter((n) => slots.has(n));
                  if (validNums.length === 0) {
                    return yield* new CcswapOperationError({
                      message: "Select at least one valid slot for the profile.",
                    });
                  }
                  profiles.set(input.name, validNums);
                  yield* saveProfiles(profiles).pipe(Effect.mapError(mapOpError));
                  return yield* buildSnapshot({ fetchUsage: false, forceRefreshUsage: false });
                }

                if (!profiles.has(input.name)) {
                  return yield* new CcswapOperationError({
                    message: `Profile "${input.name}" not found.`,
                  });
                }

                if (input.action === "delete") {
                  profiles.delete(input.name);
                  yield* saveProfiles(profiles).pipe(Effect.mapError(mapOpError));
                  if (asString(state["profile"]) === input.name) {
                    state["profile"] = null;
                    yield* saveState(state).pipe(Effect.mapError(mapOpError));
                  }
                  return yield* buildSnapshot({ fetchUsage: false, forceRefreshUsage: false });
                }

                const pool = new Map<number, StoredSlot>();
                for (const n of profiles.get(input.name)!) {
                  const s = slots.get(n);
                  if (s) pool.set(n, s);
                }
                if (pool.size === 0) {
                  return yield* new CcswapOperationError({
                    message: `Profile "${input.name}" has no valid slots.`,
                  });
                }
                state["profile"] = input.name;
                yield* saveState(state).pipe(Effect.mapError(mapOpError));

                const { oauth, account } = yield* readGlobalActive().pipe(
                  Effect.mapError(mapOpError),
                );
                const active = findActiveSlot(slots, oauth, account);
                if (active === null || !pool.has(active)) {
                  const best = yield* leastUsedSlot({
                    candidates: pool,
                    allSlots: slots,
                    globalActiveSlot: active,
                    models: [],
                  });
                  const targetNum = best ?? pool.keys().next().value!;
                  yield* doSwitch(targetNum, slots, `profile ${input.name}`);
                }
                return yield* buildSnapshot({ fetchUsage: false, forceRefreshUsage: false });
              }),
            ),
          );
        }),

        syncT3Instances: Effect.fn("CcswapService.syncT3Instances")(function* (input) {
          return yield* provideEnv(storeSemaphore.withPermits(1)(syncT3InstancesImpl(input)));
        }),

        runAutoCheck: Effect.fn("CcswapService.runAutoCheck")(function* (input) {
          return yield* provideEnv(storeSemaphore.withPermits(1)(runAutoCheckImpl(input)));
        }),

        resolveTurnInstance: Effect.fn("CcswapService.resolveTurnInstance")(function* (input) {
          return yield* provideEnv(
            Effect.gen(function* () {
              const settings = yield* serverSettings.getSettings.pipe(
                Effect.orElseSucceed(() => null),
              );
              const auto = settings?.ccswapAuto;
              if (!settings || !auto?.enabled || !auto.autoRouteT3Turns) return input.instanceId;

              const currentSlot = parseCcswapSlotFromInstanceId(input.instanceId);
              if (
                currentSlot === null &&
                input.instanceId !== ProviderInstanceId.make("claudeAgent")
              ) {
                return input.instanceId;
              }

              return yield* storeSemaphore
                .withPermits(1)(
                  Effect.gen(function* () {
                    const slots = yield* loadSlots();
                    if (slots.size < 2) return input.instanceId;
                    yield* syncLiveTokensIntoSlots(slots);
                    const state = yield* loadState();
                    const profiles = yield* loadProfiles();
                    const activeProfileName = asString(state["profile"]);
                    const activeProfile =
                      activeProfileName && profiles.has(activeProfileName)
                        ? activeProfileName
                        : null;
                    const scoped = resolveScopedSlots(slots, profiles, activeProfile);

                    const models = [
                      ...auto.modelFilter
                        .split(",")
                        .map((m) => m.trim())
                        .filter(Boolean),
                      ...(input.model ? [input.model] : []),
                    ];

                    let effectiveSlot = currentSlot;
                    if (effectiveSlot === null) {
                      const { oauth, account } = yield* readGlobalActive();
                      effectiveSlot = findActiveSlot(slots, oauth, account);
                    }
                    if (effectiveSlot === null) return input.instanceId;

                    const currentStored = slots.get(effectiveSlot);
                    if (!currentStored) return input.instanceId;

                    const currentUsage = yield* usageForSlot({
                      slotNum: effectiveSlot,
                      slot: currentStored,
                      slots,
                      isGlobalActive: false,
                      forceRefresh: false,
                    });
                    const currentPct = worstPct(currentUsage.rawUsage, models);
                    if (currentPct === null || currentPct < auto.threshold) {
                      return input.instanceId;
                    }

                    const candidates: Array<{ slot: number; pct: number | null }> = [];
                    for (const [num, slot] of scoped.entries()) {
                      if (num === effectiveSlot) continue;
                      const candidateId = slotInstanceId(num);
                      const instanceCfg = settings.providerInstances[candidateId];
                      if (
                        !instanceCfg ||
                        instanceCfg.driver !== "claudeAgent" ||
                        instanceCfg.enabled === false
                      ) {
                        continue;
                      }
                      const res = yield* usageForSlot({
                        slotNum: num,
                        slot,
                        slots,
                        isGlobalActive: false,
                        forceRefresh: false,
                      });
                      candidates.push({ slot: num, pct: worstPct(res.rawUsage, models) });
                    }
                    const target = pickTurnSlot({
                      currentPct,
                      candidates,
                      threshold: auto.threshold,
                    });
                    return target === null ? input.instanceId : slotInstanceId(target);
                  }),
                )
                .pipe(Effect.orElseSucceed(() => input.instanceId));
            }),
          );
        }),
      };
    }),
  );
}
