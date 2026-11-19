import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const SHARED_CLAUDE_ENTRIES = [
  "settings.json",
  "settings.local.json",
  "CLAUDE.md",
  "skills",
  "plugins",
  "projects",
  "agents",
  "commands",
  "hooks",
  "plans",
  "rules",
  "output-styles",
  "statsig",
  "mcp-needs-auth-cache.json",
] as const;

const LOCK_STALE_MS = 60_000;
const LOCK_TIMEOUT_MS = 9_000;
const LOCK_RETRY_MS = 100;

export type JsonRecord = Record<string, unknown>;

const decodeJsonUnknown = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const encodeJsonPretty = Schema.encodeUnknownEffect(fromJsonStringPretty(Schema.Unknown));

export class ClaudeHomeLockError extends Schema.TaggedError<ClaudeHomeLockError>()(
  "ClaudeHomeLockError",
  {
    lockPath: Schema.String,
  },
) {
  override get message(): string {
    return `Claude lock busy: ${this.lockPath}`;
  }
}

export const readJsonRecord = Effect.fn("ClaudeHomeLayout.readJsonRecord")(function* (
  filePath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const content = yield* fs.readFileString(filePath).pipe(Effect.orElseSucceed(() => ""));
  if (content.trim().length === 0) return {} as JsonRecord;
  const parsed = yield* decodeJsonUnknown(content).pipe(Effect.orElseSucceed(() => undefined));
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as JsonRecord)
    : ({} as JsonRecord);
});

export const writeJsonRecordAtomic = Effect.fn("ClaudeHomeLayout.writeJsonRecordAtomic")(function* (
  filePath: string,
  data: JsonRecord,
  mode = 0o600,
) {
  const fs = yield* FileSystem.FileSystem;
  const pretty = yield* encodeJsonPretty(data);
  yield* writeFileStringAtomically({
    filePath,
    contents: `${pretty}\n`,
  });
  yield* fs.chmod(filePath, mode).pipe(Effect.ignore());
});

const acquireDirLock = Effect.fn("ClaudeHomeLayout.acquireDirLock")(function* (lockPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(lockPath), { recursive: true });
  const startMs = yield* Clock.currentTimeMillis;
  const deadline = startMs + LOCK_TIMEOUT_MS;
  while (true) {
    const created = yield* fs.makeDirectory(lockPath).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    if (created) {
      return lockPath;
    }
    const statOpt = yield* fs.stat(lockPath).pipe(Effect.option);
    const nowMs = yield* Clock.currentTimeMillis;
    if (Option.isSome(statOpt)) {
      const mtime = statOpt.value.mtime;
      const mtimeMs = Option.isSome(mtime) ? mtime.value.getTime() : 0;
      if (mtimeMs > 0 && nowMs - mtimeMs > LOCK_STALE_MS) {
        yield* fs.remove(lockPath, { recursive: true }).pipe(Effect.ignore());
        continue;
      }
    }
    if (nowMs >= deadline) {
      return yield* new ClaudeHomeLockError({ lockPath });
    }
    yield* Effect.sleep(`${LOCK_RETRY_MS} millis`);
  }
});

const releaseDirLock = Effect.fn("ClaudeHomeLayout.releaseDirLock")(function* (lockPath: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.remove(lockPath, { recursive: true }).pipe(Effect.ignore());
});

export const withClaudeDirLocks = <A, E, R>(
  configDir: string,
  globalConfigFile: string,
  use: Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const locks = [
        path.join(configDir, ".oauth_refresh.lock"),
        `${configDir}.lock`,
        `${globalConfigFile}.lock`,
      ];
      for (const lockPath of locks) {
        yield* Effect.acquireRelease(acquireDirLock(lockPath), releaseDirLock);
      }
      return yield* use;
    }),
  );

export const ensureClaudeShadowHome = Effect.fn("ClaudeHomeLayout.ensureClaudeShadowHome")(
  function* (input: {
    readonly sharedClaudeDir: string;
    readonly shadowHomeDir: string;
    readonly globalConfigFile: string;
    readonly oauth: JsonRecord;
    readonly account: JsonRecord;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    yield* fs.makeDirectory(input.shadowHomeDir, { recursive: true });
    yield* fs.chmod(input.shadowHomeDir, 0o700).pipe(Effect.ignore());

    for (const entry of SHARED_CLAUDE_ENTRIES) {
      const sourcePath = path.join(input.sharedClaudeDir, entry);
      const targetPath = path.join(input.shadowHomeDir, entry);
      const sourceExists = yield* fs.exists(sourcePath).pipe(Effect.orElseSucceed(() => false));
      if (!sourceExists) continue;

      const existingLink = yield* fs.readLink(targetPath).pipe(Effect.option);
      if (Option.isSome(existingLink)) {
        if (path.resolve(input.shadowHomeDir, existingLink.value) === path.resolve(sourcePath)) {
          continue;
        }
        yield* fs.remove(targetPath, { recursive: true }).pipe(Effect.ignore());
      } else {
        const targetExists = yield* fs.exists(targetPath).pipe(Effect.orElseSucceed(() => false));
        if (targetExists) {
          continue;
        }
      }
      yield* fs.symlink(sourcePath, targetPath).pipe(Effect.ignore());
    }

    const credPath = path.join(input.shadowHomeDir, ".credentials.json");
    const claudeJsonPath = path.join(input.shadowHomeDir, ".claude.json");

    yield* withClaudeDirLocks(
      input.shadowHomeDir,
      claudeJsonPath,
      Effect.gen(function* () {
        const creds = yield* readJsonRecord(credPath);
        creds["claudeAiOauth"] = input.oauth;
        yield* writeJsonRecordAtomic(credPath, creds, 0o600);

        const existingClaudeJson = yield* readJsonRecord(claudeJsonPath);
        let baseConfig = existingClaudeJson;
        if (Object.keys(existingClaudeJson).length === 0) {
          const globalCfg = yield* readJsonRecord(input.globalConfigFile);
          baseConfig = { ...globalCfg };
        }
        if (Object.keys(input.account).length > 0) {
          baseConfig["oauthAccount"] = input.account;
        }
        yield* writeJsonRecordAtomic(claudeJsonPath, baseConfig, 0o600);
      }),
    );
  },
);
