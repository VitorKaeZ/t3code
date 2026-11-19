import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpClient, HttpClientResponse } from "effect/http";
import { expect } from "vite-plus/test";

import { ServerSettingsService } from "../serverSettings.ts";
import { CcswapService } from "./CcswapService.ts";
import { ProviderRegistry } from "./ProviderRegistry.ts";

const makeTestLayer = (input: {
  readonly homeDir: string;
  readonly ccswapRoot: string;
  readonly claudeConfigDir: string;
  readonly usageByToken: Record<string, unknown>;
}) => {
  const hostEnvLayer = Layer.mergeAll(
    Layer.succeed(HostProcess.HomeDirectory, input.homeDir),
    Layer.succeed(HostProcess.Environment, {
      CLAUDE_CONFIG_DIR: input.claudeConfigDir,
      CCSWAP_HOME: input.ccswapRoot,
    }),
    Layer.succeed(HostProcess.Platform, "linux"),
  );

  const httpLayer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      const auth = request.headers["authorization"] ?? "";
      const token = auth.replace(/^Bearer\s+/i, "");
      const body = input.usageByToken[token] ?? {
        five_hour: { utilization: 10, resets_at: "2030-01-01T05:00:00Z" },
        seven_day: { utilization: 20, resets_at: "2030-01-05T00:00:00Z" },
      };
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, Response.json(body, { status: 200 })),
      );
    }),
  );

  const registryLayer = Layer.mock(ProviderRegistry)({
    refresh: () => Effect.succeed([]),
  });

  const settingsLayer = ServerSettingsService.layerTest();

  return CcswapService.layer.pipe(
    Layer.provideMerge(settingsLayer),
    Layer.provideMerge(registryLayer),
    Layer.provideMerge(httpLayer),
    Layer.provideMerge(hostEnvLayer),
    Layer.provideMerge(NodeServices.layer),
  );
};

effectIt.layer(NodeServices.layer)("CcswapService", (it) => {
  it.effect(
    "manages slots, switches preserving keys, syncs T3 shadow homes, profiles, and auto-switch",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped();
        const claudeConfigDir = path.join(root, ".claude");
        const ccswapRoot = path.join(root, "ccswap");
        yield* fs.makeDirectory(claudeConfigDir, { recursive: true });
        yield* fs.makeDirectory(path.join(claudeConfigDir, "skills"), { recursive: true });
        yield* fs.writeFileString(path.join(claudeConfigDir, "settings.json"), '{"theme":"dark"}');

        const writeGlobalLogin = (email: string, token: string) =>
          Effect.gen(function* () {
            yield* fs.writeFileString(
              path.join(claudeConfigDir, ".credentials.json"),
              JSON.stringify({
                mcpOAuth: { server1: "keep-me" },
                claudeAiOauth: {
                  accessToken: token,
                  refreshToken: `ref-${token}`,
                  expiresAt: (yield* Clock.currentTimeMillis) + 3_600_000,
                  subscriptionType: "claude_max_5x_subscription",
                },
              }),
            );
            yield* fs.writeFileString(
              path.join(claudeConfigDir, ".claude.json"),
              JSON.stringify({
                oauthAccount: { emailAddress: email, organizationUuid: `org-${token}` },
              }),
            );
          });

        const usageByToken = {
          "tok-a": {
            five_hour: { utilization: 96, resets_at: "2030-01-01T05:00:00Z" },
            seven_day: { utilization: 40, resets_at: "2030-01-05T00:00:00Z" },
          },
          "tok-b": {
            five_hour: { utilization: 15, resets_at: "2030-01-01T06:00:00Z" },
            seven_day: { utilization: 25, resets_at: "2030-01-06T00:00:00Z" },
          },
        };

        const layer = makeTestLayer({
          homeDir: root,
          ccswapRoot,
          claudeConfigDir,
          usageByToken,
        });

        yield* Effect.gen(function* () {
          const ccswap = yield* CcswapService;
          const settings = yield* ServerSettingsService;

          // 1. Add account A
          yield* writeGlobalLogin("alice@example.com", "tok-a");
          const s1 = yield* ccswap.addActive({ alias: "work" });
          expect(s1.slots).toHaveLength(1);
          expect(s1.slots[0]?.email).toBe("alice@example.com");
          expect(s1.slots[0]?.alias).toBe("work");
          expect(s1.slots[0]?.isGlobalActive).toBe(true);

          // 2. Add account B
          yield* writeGlobalLogin("bob@example.com", "tok-b");
          const s2 = yield* ccswap.addActive({ alias: "personal" });
          expect(s2.slots).toHaveLength(2);
          expect(s2.globalActiveSlot).toBe(2);

          // 3. Switch to slot 1 preserving mcpOAuth
          const sw = yield* ccswap.switchAccount({ target: 1 });
          expect(sw.switchedToSlot).toBe(1);
          expect(sw.switchedToEmail).toBe("alice@example.com");
          const credsRaw = JSON.parse(
            yield* fs.readFileString(path.join(claudeConfigDir, ".credentials.json")),
          ) as Record<string, unknown>;
          expect(credsRaw["mcpOAuth"]).toEqual({ server1: "keep-me" });

          // 4. Sync T3 instances creates symlinked shadow homes and registers ccswap-slot-*
          const synced = yield* ccswap.syncT3Instances({});
          expect(synced.syncedInstances).toEqual([
            ProviderInstanceId.make("ccswap-slot-1"),
            ProviderInstanceId.make("ccswap-slot-2"),
          ]);
          const currentSettings = yield* settings.getSettings;
          expect(
            currentSettings.providerInstances[ProviderInstanceId.make("ccswap-slot-1")]
              ?.displayName,
          ).toBe("work");
          const shadowSettingsLink = yield* fs.readLink(
            path.join(ccswapRoot, "homes", "slot-1", "settings.json"),
          );
          expect(shadowSettingsLink).toBe(path.join(claudeConfigDir, "settings.json"));

          // 5. Profiles: create profile for slot 2 and activate -> switches to slot 2
          yield* ccswap.profileAction({ action: "set", name: "personal-only", slots: [2] });
          const afterProfile = yield* ccswap.profileAction({
            action: "use",
            name: "personal-only",
          });
          expect(afterProfile.activeProfile).toBe("personal-only");
          expect(afterProfile.globalActiveSlot).toBe(2);

          // Disable profile and switch back to slot 1 (96% 5h), then run auto-check -> switches to slot 2 (25%)
          yield* ccswap.profileAction({ action: "off" });
          yield* ccswap.switchAccount({ target: 1 });
          // Clear cooldown in state.json so auto-check runs immediately
          yield* fs.writeFileString(
            path.join(ccswapRoot, "state.json"),
            JSON.stringify({ active: 1 }),
          );
          const autoRes = yield* ccswap.runAutoCheck({ dryRun: false });
          expect(autoRes.outcome).toBe("switched");
          expect(autoRes.switchedToSlot).toBe(2);
        }).pipe(Effect.provide(layer));
      }),
  );
});
