import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const CcswapWindowUsage = Schema.Struct({
  pct: Schema.Number,
  resetsAt: Schema.NullOr(Schema.String),
});
export type CcswapWindowUsage = typeof CcswapWindowUsage.Type;

export const CcswapSlotUsage = Schema.Struct({
  fiveHour: Schema.NullOr(CcswapWindowUsage),
  sevenDay: Schema.NullOr(CcswapWindowUsage),
  modelWindows: Schema.Record(Schema.String, CcswapWindowUsage),
  checkedAt: Schema.NullOr(Schema.Number),
  stale: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
});
export type CcswapSlotUsage = typeof CcswapSlotUsage.Type;

export const CcswapAccountSlot = Schema.Struct({
  slot: Schema.Number,
  email: Schema.String,
  alias: Schema.NullOr(Schema.String),
  plan: Schema.NullOr(Schema.String),
  isGlobalActive: Schema.Boolean,
  inActiveProfile: Schema.Boolean,
  tokenValid: Schema.Boolean,
  tokenExpiresAt: Schema.NullOr(Schema.Number),
  t3InstanceId: Schema.NullOr(ProviderInstanceId),
  t3HomePath: Schema.NullOr(Schema.String),
  usage: Schema.NullOr(CcswapSlotUsage),
});
export type CcswapAccountSlot = typeof CcswapAccountSlot.Type;

export const CcswapProfile = Schema.Struct({
  name: TrimmedNonEmptyString,
  slots: Schema.Array(Schema.Number),
  active: Schema.Boolean,
});
export type CcswapProfile = typeof CcswapProfile.Type;

export const CcswapAutoSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  threshold: Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 100 })).pipe(
    Schema.withDecodingDefault(Effect.succeed(95)),
  ),
  margin: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 })).pipe(
    Schema.withDecodingDefault(Effect.succeed(10)),
  ),
  cooldownSeconds: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 86_400 })).pipe(
    Schema.withDecodingDefault(Effect.succeed(300)),
  ),
  intervalSeconds: Schema.Number.check(Schema.isBetween({ minimum: 15, maximum: 3_600 })).pipe(
    Schema.withDecodingDefault(Effect.succeed(60)),
  ),
  modelFilter: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  autoRouteT3Turns: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
export type CcswapAutoSettings = typeof CcswapAutoSettings.Type;

export const CcswapStateSnapshot = Schema.Struct({
  globalActiveEmail: Schema.NullOr(Schema.String),
  globalActiveSlot: Schema.NullOr(Schema.Number),
  globalConflictWithT3Instance: Schema.NullOr(ProviderInstanceId),
  activeProfile: Schema.NullOr(Schema.String),
  profiles: Schema.Array(CcswapProfile),
  slots: Schema.Array(CcswapAccountSlot),
  lastSwitchAt: Schema.NullOr(Schema.Number),
  lastAutoMessage: Schema.NullOr(Schema.String),
  autoConfig: CcswapAutoSettings,
});
export type CcswapStateSnapshot = typeof CcswapStateSnapshot.Type;

export const CcswapGetStateInput = Schema.Struct({
  refreshUsage: Schema.optional(Schema.Boolean),
});
export type CcswapGetStateInput = typeof CcswapGetStateInput.Type;

export const CcswapAddActiveInput = Schema.Struct({
  alias: Schema.optional(TrimmedString),
});
export type CcswapAddActiveInput = typeof CcswapAddActiveInput.Type;

export const CcswapRemoveSlotInput = Schema.Struct({
  slot: Schema.Number,
});
export type CcswapRemoveSlotInput = typeof CcswapRemoveSlotInput.Type;

export const CcswapSetAliasInput = Schema.Struct({
  slot: Schema.Number,
  alias: Schema.NullOr(TrimmedString),
});
export type CcswapSetAliasInput = typeof CcswapSetAliasInput.Type;

export const CcswapSwitchInput = Schema.Struct({
  target: Schema.Union([Schema.Number, Schema.Literals(["next", "best"])]),
});
export type CcswapSwitchInput = typeof CcswapSwitchInput.Type;

export const CcswapSwitchResult = Schema.Struct({
  state: CcswapStateSnapshot,
  switchedToSlot: Schema.Number,
  switchedToEmail: Schema.String,
  reason: Schema.String,
});
export type CcswapSwitchResult = typeof CcswapSwitchResult.Type;

export const CcswapProfileActionInput = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("set"),
    name: TrimmedNonEmptyString,
    slots: Schema.Array(Schema.Number),
  }),
  Schema.Struct({
    action: Schema.Literal("use"),
    name: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    action: Schema.Literal("off"),
  }),
  Schema.Struct({
    action: Schema.Literal("delete"),
    name: TrimmedNonEmptyString,
  }),
]);
export type CcswapProfileActionInput = typeof CcswapProfileActionInput.Type;

export const CcswapSyncT3Input = Schema.Struct({
  slot: Schema.optional(Schema.Number),
});
export type CcswapSyncT3Input = typeof CcswapSyncT3Input.Type;

export const CcswapSyncT3Result = Schema.Struct({
  state: CcswapStateSnapshot,
  syncedInstances: Schema.Array(ProviderInstanceId),
});
export type CcswapSyncT3Result = typeof CcswapSyncT3Result.Type;

export const CcswapRunAutoInput = Schema.Struct({
  dryRun: Schema.optional(Schema.Boolean),
});
export type CcswapRunAutoInput = typeof CcswapRunAutoInput.Type;

export const CcswapRunAutoResult = Schema.Struct({
  state: CcswapStateSnapshot,
  outcome: Schema.Literals(["switched", "noop", "blocked", "error"]),
  message: Schema.String,
  switchedToSlot: Schema.optional(Schema.Number),
});
export type CcswapRunAutoResult = typeof CcswapRunAutoResult.Type;

export class CcswapOperationError extends Schema.TaggedError<CcswapOperationError>()(
  "CcswapOperationError",
  {
    message: Schema.String,
  },
) {}
