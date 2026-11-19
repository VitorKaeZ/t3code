import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  CcswapAccountSlot,
  CcswapAutoSettings,
  CcswapStateSnapshot,
  CcswapWindowUsage,
  EnvironmentId,
} from "@t3tools/contracts";
import {
  AlertTriangleIcon,
  ArrowRightLeftIcon,
  CheckIcon,
  GaugeIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useState } from "react";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { RefreshIcon } from "../ui/refresh-icon";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

function formatResetTime(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const diffMin = Math.max(0, Math.round((ms - Date.now()) / 60_000));
  if (diffMin < 60) return `in ${diffMin}m`;
  const h = Math.floor(diffMin / 60);
  const m = diffMin % 60;
  if (h < 24) return m > 0 ? `in ${h}h${m}m` : `in ${h}h`;
  const d = Math.floor(h / 24);
  const remH = h % 24;
  return remH > 0 ? `in ${d}d${remH}h` : `in ${d}d`;
}

function barToneClass(pct: number): string {
  if (pct >= 95) return "bg-destructive";
  if (pct >= 75) return "bg-warning";
  return "bg-emerald-500";
}

function UsageMiniBar({
  label,
  window,
}: {
  readonly label: string;
  readonly window: CcswapWindowUsage;
}) {
  const pct = Math.max(0, Math.min(100, window.pct));
  const reset = formatResetTime(window.resetsAt);
  return (
    <div className="flex min-w-36 flex-col gap-1">
      <div className="flex items-center justify-between gap-2 text-2xs text-muted-foreground">
        <span className="font-medium text-foreground/80">{label}</span>
        <span className="tabular-nums">
          {pct.toFixed(0)}%{reset ? ` · ${reset}` : ""}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full transition-all", barToneClass(pct))}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function AccountSlotRow({
  slot,
  readOnly,
  busy,
  onSwitch,
  onSync,
  onSetAlias,
  onRemove,
}: {
  readonly slot: CcswapAccountSlot;
  readonly readOnly: boolean;
  readonly busy: boolean;
  readonly onSwitch: (slot: number) => void;
  readonly onSync: (slot: number) => void;
  readonly onSetAlias: (slot: number, alias: string | null) => void;
  readonly onRemove: (slot: number) => void;
}) {
  const [editingAlias, setEditingAlias] = useState(false);
  const [aliasDraft, setAliasDraft] = useState(slot.alias ?? "");

  const displayName = slot.alias ? `${slot.alias} (${slot.email})` : slot.email;

  return (
    <div className="flex flex-col gap-2.5 px-3 py-3 sm:px-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-2xs text-muted-foreground">
            #{slot.slot}
          </span>
          {editingAlias ? (
            <form
              className="flex items-center gap-1.5"
              onSubmit={(event) => {
                event.preventDefault();
                onSetAlias(slot.slot, aliasDraft.trim() || null);
                setEditingAlias(false);
              }}
            >
              <Input
                size="sm"
                className="h-7 w-40"
                value={aliasDraft}
                placeholder="Alias (optional)"
                onChange={(e) => setAliasDraft(e.target.value)}
              />
              <Button type="submit" size="xs" variant="secondary" disabled={busy}>
                <CheckIcon className="size-3" />
              </Button>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                onClick={() => {
                  setAliasDraft(slot.alias ?? "");
                  setEditingAlias(false);
                }}
              >
                Cancel
              </Button>
            </form>
          ) : (
            <span className="truncate text-sm font-medium text-foreground">{displayName}</span>
          )}
          {slot.plan ? (
            <Badge variant="outline" size="sm">
              {slot.plan}
            </Badge>
          ) : null}
          {slot.isGlobalActive ? (
            <Badge variant="secondary" size="sm">
              Global active
            </Badge>
          ) : null}
          {slot.t3InstanceId ? (
            <Badge variant="outline" size="sm">
              T3: {slot.t3InstanceId}
            </Badge>
          ) : null}
          {!slot.tokenValid ? (
            <Badge variant="destructive" size="sm">
              Token expired
            </Badge>
          ) : null}
          {!slot.inActiveProfile ? (
            <Badge variant="outline" size="sm">
              Outside profile
            </Badge>
          ) : null}
        </div>

        {!readOnly ? (
          <div className="flex flex-wrap items-center gap-1">
            {!slot.isGlobalActive ? (
              <Button
                size="xs"
                variant="outline"
                disabled={busy}
                onClick={() => onSwitch(slot.slot)}
              >
                Use globally
              </Button>
            ) : null}
            <Button size="xs" variant="ghost" disabled={busy} onClick={() => onSync(slot.slot)}>
              {slot.t3InstanceId ? "Re-sync T3" : "Add to T3"}
            </Button>
            {!editingAlias ? (
              <Button
                size="xs"
                variant="ghost"
                aria-label={`Edit alias for ${slot.email}`}
                disabled={busy}
                onClick={() => {
                  setAliasDraft(slot.alias ?? "");
                  setEditingAlias(true);
                }}
              >
                <PencilIcon className="size-3" />
              </Button>
            ) : null}
            <Button
              size="xs"
              variant="ghost"
              aria-label={`Remove ${slot.email}`}
              disabled={busy}
              onClick={() => onRemove(slot.slot)}
            >
              <Trash2Icon className="size-3 text-destructive" />
            </Button>
          </div>
        ) : null}
      </div>

      {slot.usage ? (
        <div className="flex flex-wrap items-center gap-4">
          {slot.usage.fiveHour ? <UsageMiniBar label="5h" window={slot.usage.fiveHour} /> : null}
          {slot.usage.sevenDay ? <UsageMiniBar label="7d" window={slot.usage.sevenDay} /> : null}
          {Object.entries(slot.usage.modelWindows).map(([model, win]) => (
            <UsageMiniBar key={model} label={`7d · ${model}`} window={win} />
          ))}
          {slot.usage.stale || slot.usage.error ? (
            <span className="text-2xs text-muted-foreground">
              {slot.usage.stale ? "~ cached" : null}
              {slot.usage.error ? ` (${slot.usage.error})` : null}
            </span>
          ) : null}
        </div>
      ) : (
        <p className="text-2xs text-muted-foreground">Usage not loaded yet.</p>
      )}
    </div>
  );
}

export function ClaudeAccountsSettings({
  environmentId,
  autoSettings,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly autoSettings: CcswapAutoSettings;
  readonly readOnly: boolean;
}) {
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const [snapshot, setSnapshot] = useState<CcswapStateSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [newProfileName, setNewProfileName] = useState("");
  const [newProfileSlots, setNewProfileSlots] = useState<number[]>([]);
  const [showProfileForm, setShowProfileForm] = useState(false);

  const getStateCmd = useAtomCommand(serverEnvironment.ccswapGetState, { reportFailure: false });
  const addActiveCmd = useAtomCommand(serverEnvironment.ccswapAddActive, { reportFailure: false });
  const removeSlotCmd = useAtomCommand(serverEnvironment.ccswapRemoveSlot, {
    reportFailure: false,
  });
  const setAliasCmd = useAtomCommand(serverEnvironment.ccswapSetAlias, { reportFailure: false });
  const switchCmd = useAtomCommand(serverEnvironment.ccswapSwitch, { reportFailure: false });
  const profileCmd = useAtomCommand(serverEnvironment.ccswapProfileAction, {
    reportFailure: false,
  });
  const syncT3Cmd = useAtomCommand(serverEnvironment.ccswapSyncT3, { reportFailure: false });
  const runAutoCmd = useAtomCommand(serverEnvironment.ccswapRunAuto, { reportFailure: false });

  const refreshState = async (refreshUsage = false) => {
    setLoadError(null);
    setRefreshing(true);
    setBusy(true);
    try {
      const result = await getStateCmd({
        environmentId,
        input: { refreshUsage },
      });
      if (result._tag === "Success") {
        setSnapshot(result.value);
      } else {
        const failure = squashAtomCommandFailure(result);
        setLoadError(failure instanceof Error ? failure.message : String(failure));
      }
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
    setRefreshing(false);
    setBusy(false);
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fetches ccswap state from the server once per environment
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- the server fetch marks itself loading before it awaits
    void refreshState(false);
  }, [refreshState]);

  const reportUnexpectedError = (error: unknown) => {
    toastManager.add({
      type: "error",
      title: "Claude accounts request failed",
      description: error instanceof Error ? error.message : String(error),
    });
  };

  const handleFailure = (result: Parameters<typeof squashAtomCommandFailure>[0], title: string) => {
    const failure = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title,
      description: failure instanceof Error ? failure.message : String(failure),
    });
  };

  const handleAddActive = async () => {
    setBusy(true);
    try {
      const result = await addActiveCmd({ environmentId, input: {} });
      if (result._tag === "Success") {
        setSnapshot(result.value);
        toastManager.add({ type: "success", title: "Active Claude account saved to ccswap" });
      } else {
        handleFailure(result, "Could not add active Claude account");
      }
    } catch (error) {
      reportUnexpectedError(error);
    }
    setBusy(false);
  };

  const handleSwitch = async (target: number | "next" | "best") => {
    setBusy(true);
    try {
      const result = await switchCmd({ environmentId, input: { target } });
      if (result._tag === "Success") {
        setSnapshot(result.value.state);
        toastManager.add({
          type: "success",
          title: `Switched global Claude account to ${result.value.switchedToEmail}`,
          description: `Reason: ${result.value.reason}`,
        });
      } else {
        handleFailure(result, "Could not switch Claude account");
      }
    } catch (error) {
      reportUnexpectedError(error);
    }
    setBusy(false);
  };

  const handleSyncT3 = async (slot?: number) => {
    setBusy(true);
    try {
      const result = await syncT3Cmd({
        environmentId,
        input: slot !== undefined ? { slot } : {},
      });
      if (result._tag === "Success") {
        setSnapshot(result.value.state);
        toastManager.add({
          type: "success",
          title:
            result.value.syncedInstances.length === 1
              ? `Synced ${result.value.syncedInstances[0]} to T3`
              : `Synced ${result.value.syncedInstances.length} Claude account instances to T3`,
        });
      } else {
        handleFailure(result, "Could not sync Claude accounts to T3");
      }
    } catch (error) {
      reportUnexpectedError(error);
    }
    setBusy(false);
  };

  const handleSetAlias = async (slot: number, alias: string | null) => {
    setBusy(true);
    try {
      const result = await setAliasCmd({ environmentId, input: { slot, alias } });
      if (result._tag === "Success") {
        setSnapshot(result.value);
      } else {
        handleFailure(result, "Could not update alias");
      }
    } catch (error) {
      reportUnexpectedError(error);
    }
    setBusy(false);
  };

  const handleRemove = async (slot: number) => {
    setBusy(true);
    try {
      const result = await removeSlotCmd({ environmentId, input: { slot } });
      if (result._tag === "Success") {
        setSnapshot(result.value);
        toastManager.add({ type: "success", title: `Removed slot #${slot}` });
      } else {
        handleFailure(result, "Could not remove slot");
      }
    } catch (error) {
      reportUnexpectedError(error);
    }
    setBusy(false);
  };

  const handleProfileUse = async (name: string) => {
    setBusy(true);
    try {
      const result = await profileCmd({
        environmentId,
        input: name === "__all__" ? { action: "off" } : { action: "use", name },
      });
      if (result._tag === "Success") {
        setSnapshot(result.value);
      } else {
        handleFailure(result, "Could not switch profile");
      }
    } catch (error) {
      reportUnexpectedError(error);
    }
    setBusy(false);
  };

  const handleProfileDelete = async (name: string) => {
    setBusy(true);
    try {
      const result = await profileCmd({
        environmentId,
        input: { action: "delete", name },
      });
      if (result._tag === "Success") {
        setSnapshot(result.value);
      } else {
        handleFailure(result, "Could not delete profile");
      }
    } catch (error) {
      reportUnexpectedError(error);
    }
    setBusy(false);
  };

  const handleCreateProfile = async () => {
    const trimmed = newProfileName.trim();
    if (!trimmed || newProfileSlots.length === 0) return;
    setBusy(true);
    try {
      const result = await profileCmd({
        environmentId,
        input: { action: "set", name: trimmed, slots: newProfileSlots },
      });
      if (result._tag === "Success") {
        setSnapshot(result.value);
        setNewProfileName("");
        setNewProfileSlots([]);
        setShowProfileForm(false);
      } else {
        handleFailure(result, "Could not save profile");
      }
    } catch (error) {
      reportUnexpectedError(error);
    }
    setBusy(false);
  };

  const handleRunAuto = async () => {
    setBusy(true);
    try {
      const result = await runAutoCmd({ environmentId, input: { dryRun: false } });
      if (result._tag === "Success") {
        setSnapshot(result.value.state);
        toastManager.add({
          type: result.value.outcome === "error" ? "error" : "info",
          title: `Auto-check: ${result.value.outcome}`,
          description: result.value.message,
        });
      } else {
        handleFailure(result, "Auto-switch check failed");
      }
    } catch (error) {
      reportUnexpectedError(error);
    }
    setBusy(false);
  };

  const patchAuto = (patch: Partial<CcswapAutoSettings>) => {
    updateSettings({
      ccswapAuto: {
        ...autoSettings,
        ...patch,
      },
    });
  };

  return (
    <SettingsSection
      {...searchableSetting("claude-accounts")}
      headerAction={
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            size="xs"
            variant="ghost"
            disabled={busy}
            onClick={() => void refreshState(true)}
            aria-label="Refresh Claude accounts usage"
          >
            <RefreshIcon size="xs" refreshing={refreshing} />
            Refresh
          </Button>
          {!readOnly ? (
            <>
              <Button
                size="xs"
                variant="outline"
                disabled={busy}
                onClick={() => void handleAddActive()}
              >
                <PlusIcon className="size-3" />
                Add active
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={busy || !snapshot || snapshot.slots.length === 0}
                onClick={() => void handleSyncT3()}
              >
                Sync all to T3
              </Button>
              <Button
                size="xs"
                variant="ghost"
                disabled={busy || !snapshot || snapshot.slots.length < 2}
                onClick={() => void handleSwitch("next")}
              >
                <ArrowRightLeftIcon className="size-3" />
                Next
              </Button>
              <Button
                size="xs"
                variant="secondary"
                disabled={busy || !snapshot || snapshot.slots.length < 2}
                onClick={() => void handleSwitch("best")}
              >
                <GaugeIcon className="size-3" />
                Best
              </Button>
            </>
          ) : null}
        </div>
      }
    >
      {loadError ? (
        <div className="px-3 py-2.5 sm:px-4">
          <Alert variant="error">
            <AlertTriangleIcon aria-hidden />
            <AlertDescription>{loadError}</AlertDescription>
          </Alert>
        </div>
      ) : null}

      {snapshot?.globalConflictWithT3Instance ? (
        <div className="px-3 py-2.5 sm:px-4">
          <Alert variant="info">
            <AlertTriangleIcon aria-hidden />
            <AlertDescription>
              The default <code>claudeAgent</code> instance uses <code>~/.claude</code> globally.
              Use <strong>Sync all to T3</strong> and select the per-account{" "}
              <code>ccswap-slot-*</code> instances in the model picker to avoid OAuth refresh
              conflicts across accounts.
            </AlertDescription>
          </Alert>
        </div>
      ) : null}

      {snapshot === null ? (
        <SettingsRow title="Loading ccswap accounts..." />
      ) : snapshot.slots.length === 0 ? (
        <SettingsRow
          title="No ccswap accounts saved yet."
          description={
            snapshot.globalActiveEmail
              ? `Currently signed in globally as ${snapshot.globalActiveEmail}. Click "Add active" to save it to ccswap.`
              : "Sign in with Claude Code (`claude /login`), then click Add active."
          }
        />
      ) : (
        <div className="divide-y divide-border/60">
          {snapshot.slots.map((slot) => (
            <AccountSlotRow
              key={slot.slot}
              slot={slot}
              readOnly={readOnly}
              busy={busy}
              onSwitch={(n) => void handleSwitch(n)}
              onSync={(n) => void handleSyncT3(n)}
              onSetAlias={(n, alias) => void handleSetAlias(n, alias)}
              onRemove={(n) => void handleRemove(n)}
            />
          ))}
        </div>
      )}

      {snapshot && snapshot.slots.length > 0 ? (
        <SettingsRow
          title="Active profile"
          description="When a profile is active, Next, Best, and Auto-Switch only rotate within its accounts."
          control={
            <div className="flex flex-wrap items-center gap-1.5">
              <select
                aria-label="Active ccswap profile"
                disabled={readOnly || busy}
                value={snapshot.activeProfile ?? "__all__"}
                onChange={(e) => void handleProfileUse(e.target.value)}
                className="h-7 rounded-md border border-input bg-background px-2 text-xs text-foreground"
              >
                <option value="__all__">All accounts</option>
                {snapshot.profiles.map((profile) => (
                  <option key={profile.name} value={profile.name}>
                    {profile.name} ({profile.slots.map((n) => `#${n}`).join(", ")})
                  </option>
                ))}
              </select>
              {!readOnly && snapshot.activeProfile ? (
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void handleProfileDelete(snapshot.activeProfile!)}
                >
                  Delete
                </Button>
              ) : null}
              {!readOnly ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setShowProfileForm((prev) => !prev)}
                >
                  {showProfileForm ? "Close" : "New profile"}
                </Button>
              ) : null}
            </div>
          }
        />
      ) : null}

      {showProfileForm && snapshot && !readOnly ? (
        <div className="flex flex-col gap-2.5 border-t border-border/60 px-3 py-3 sm:px-4">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              size="sm"
              className="h-7 w-44"
              placeholder="Profile name (e.g. empresa)"
              value={newProfileName}
              onChange={(e) => setNewProfileName(e.target.value)}
            />
            <div className="flex flex-wrap items-center gap-2">
              {snapshot.slots.map((s) => {
                const checked = newProfileSlots.includes(s.slot);
                return (
                  <label key={s.slot} className="inline-flex items-center gap-1 text-xs">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => {
                        setNewProfileSlots((prev) =>
                          e.target.checked ? [...prev, s.slot] : prev.filter((id) => id !== s.slot),
                        );
                      }}
                    />
                    #{s.slot} {s.alias || s.email}
                  </label>
                );
              })}
            </div>
            <Button
              size="xs"
              variant="secondary"
              disabled={busy || !newProfileName.trim() || newProfileSlots.length === 0}
              onClick={() => void handleCreateProfile()}
            >
              Save profile
            </Button>
          </div>
        </div>
      ) : null}

      <SettingsRow
        title="Auto-switch global Claude account"
        description="Background monitor that switches ~/.claude when the active account crosses the usage threshold."
        control={
          <div className="flex items-center gap-2">
            {!readOnly ? (
              <Button
                size="xs"
                variant="outline"
                disabled={busy}
                onClick={() => void handleRunAuto()}
              >
                Run check now
              </Button>
            ) : null}
            <Switch
              aria-label="Enable ccswap auto-switch"
              checked={autoSettings.enabled}
              disabled={readOnly}
              onCheckedChange={(enabled) => patchAuto({ enabled })}
            />
          </div>
        }
      />

      <SettingsRow
        title="Auto-switch rules"
        description={
          snapshot?.lastAutoMessage
            ? `Last check: ${snapshot.lastAutoMessage}`
            : "Threshold %, minimum margin %, cooldown (s), check interval (s), and optional model filter."
        }
        control={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <label className="flex items-center gap-1 text-2xs text-muted-foreground">
              Threshold
              <Input
                type="number"
                min={1}
                max={100}
                size="compact"
                className="w-16"
                disabled={readOnly}
                value={autoSettings.threshold}
                onChange={(e) => {
                  const val = Number.parseInt(e.target.value, 10);
                  if (Number.isFinite(val) && val >= 1 && val <= 100) {
                    patchAuto({ threshold: val });
                  }
                }}
              />
            </label>
            <label className="flex items-center gap-1 text-2xs text-muted-foreground">
              Margin
              <Input
                type="number"
                min={0}
                max={100}
                size="compact"
                className="w-16"
                disabled={readOnly}
                value={autoSettings.margin}
                onChange={(e) => {
                  const val = Number.parseInt(e.target.value, 10);
                  if (Number.isFinite(val) && val >= 0 && val <= 100) {
                    patchAuto({ margin: val });
                  }
                }}
              />
            </label>
            <label className="flex items-center gap-1 text-2xs text-muted-foreground">
              Cooldown (s)
              <Input
                type="number"
                min={0}
                max={86400}
                size="compact"
                className="w-20"
                disabled={readOnly}
                value={autoSettings.cooldownSeconds}
                onChange={(e) => {
                  const val = Number.parseInt(e.target.value, 10);
                  if (Number.isFinite(val) && val >= 0 && val <= 86400) {
                    patchAuto({ cooldownSeconds: val });
                  }
                }}
              />
            </label>
            <label className="flex items-center gap-1 text-2xs text-muted-foreground">
              Interval (s)
              <Input
                type="number"
                min={15}
                max={3600}
                size="compact"
                className="w-18"
                disabled={readOnly}
                value={autoSettings.intervalSeconds}
                onChange={(e) => {
                  const val = Number.parseInt(e.target.value, 10);
                  if (Number.isFinite(val) && val >= 15 && val <= 3600) {
                    patchAuto({ intervalSeconds: val });
                  }
                }}
              />
            </label>
            <Input
              size="compact"
              className="w-28"
              placeholder="Model (e.g. sonnet)"
              disabled={readOnly}
              value={autoSettings.modelFilter}
              onChange={(e) => patchAuto({ modelFilter: e.target.value })}
            />
          </div>
        }
      />
    </SettingsSection>
  );
}
