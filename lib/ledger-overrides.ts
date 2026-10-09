import { BlobPreconditionFailedError, get, put } from "@vercel/blob";
import { isDailyCount, isManualCountField } from "@/lib/ledger-fields";
import {
  LEDGER_WEEKS,
  ledgerWeeklyGoals,
  reassembleLedger,
} from "@/lib/ledger";
import type { LedgerData, LedgerDayPatch } from "@/lib/ledger";
import type { WeeklyGoal } from "@/lib/types";
import { isValidDayKey, weekStartForDay } from "@/lib/time";
import { isStoredWeeklyGoal } from "@/lib/weekly-goal";

const LEDGER_OVERRIDES_PATHNAME = "mirror/ledger-overrides.json";

export type LedgerDayOverride = LedgerDayPatch;

// A week's goal without its key; legacy rows carry only reachouts and hours.
export type LedgerWeekOverride = Omit<WeeklyGoal, "weekStart">;

export type LedgerOverrides = {
  days: Record<string, LedgerDayOverride>;
  weeks: Record<string, LedgerWeekOverride>;
};

const emptyOverrides = (): LedgerOverrides => ({ days: {}, weeks: {} });

function validDayOverride(value: unknown): value is LedgerDayOverride {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return Object.entries(candidate).every(([field, fieldValue]) => {
    if (isManualCountField(field)) {
      return isDailyCount(fieldValue);
    }
    return field === "featureDone" && typeof fieldValue === "boolean";
  });
}

function parseOverrides(value: unknown): LedgerOverrides {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid ledger overlay");
  }
  const candidate = value as Record<string, unknown>;
  for (const field of ["days", "weeks"]) {
    if (
      !candidate[field] ||
      typeof candidate[field] !== "object" ||
      Array.isArray(candidate[field])
    ) {
      throw new Error("Invalid ledger overlay");
    }
  }
  const days: LedgerOverrides["days"] = {};
  if (
    candidate.days &&
    typeof candidate.days === "object" &&
    !Array.isArray(candidate.days)
  ) {
    for (const [day, override] of Object.entries(candidate.days)) {
      if (isValidDayKey(day) && validDayOverride(override)) {
        days[day] = override;
      } else {
        throw new Error("Invalid ledger day override");
      }
    }
  }
  const weeks: LedgerOverrides["weeks"] = {};
  if (
    candidate.weeks &&
    typeof candidate.weeks === "object" &&
    !Array.isArray(candidate.weeks)
  ) {
    for (const [weekStart, goal] of Object.entries(candidate.weeks)) {
      if (
        isValidDayKey(weekStart) &&
        weekStartForDay(weekStart) === weekStart &&
        isStoredWeeklyGoal(goal)
      ) {
        weeks[weekStart] =
          goal.emails === undefined
            ? { reachouts: goal.reachouts, hours: goal.hours }
            : {
                reachouts: goal.reachouts,
                hours: goal.hours,
                emails: goal.emails,
                connectionRequests: goal.connectionRequests,
              };
      } else {
        throw new Error("Invalid ledger week override");
      }
    }
  }
  return { days, weeks };
}

/**
 * Atomic document boundary. Reads bypass caches and return independent values;
 * null ETag means the document is absent. Writes are create-only for null, or
 * compare-and-swap otherwise. Only conflicts return false; service failures throw.
 */
export type LedgerOverrideStore = {
  read(): Promise<{ overrides: LedgerOverrides; etag: string | null }>;
  write(overrides: LedgerOverrides, etag: string | null): Promise<boolean>;
};

/** Uses the existing private document without changing its JSON shape.
 * Injectable Blob operations let isolated serverless instances share one store.
 */
export function createLedgerOverrideStore(
  blob = { get, put },
): LedgerOverrideStore {
  return {
    async read() {
      // Compression weakens ETags; CAS needs the strong token from this same read.
      const result = await blob.get(LEDGER_OVERRIDES_PATHNAME, {
        access: "private",
        useCache: false,
        headers: { "accept-encoding": "identity" },
      });
      if (!result) return { overrides: emptyOverrides(), etag: null };
      if (result.statusCode !== 200)
        throw new Error("Ledger overlay read failed");
      if (!result.blob.etag || result.blob.etag.startsWith("W/")) {
        throw new Error("Ledger overlay requires a strong ETag");
      }
      return {
        overrides: parseOverrides(await new Response(result.stream).json()),
        etag: result.blob.etag,
      };
    },
    async write(overrides, etag) {
      try {
        await blob.put(LEDGER_OVERRIDES_PATHNAME, JSON.stringify(overrides), {
          access: "private",
          addRandomSuffix: false,
          allowOverwrite: etag !== null,
          ...(etag === null ? {} : { ifMatch: etag }),
          contentType: "application/json",
          cacheControlMaxAge: 60,
        });
        return true;
      } catch (error) {
        if (error instanceof BlobPreconditionFailedError) return false;
        if (
          etag === null &&
          error instanceof Error &&
          /already exists/i.test(error.message)
        )
          return false;
        throw error;
      }
    },
  };
}

async function updateOverrides(
  store: LedgerOverrideStore,
  update: (current: LedgerOverrides) => void,
): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const { overrides, etag } = await store.read();
    update(overrides);
    if (await store.write(overrides, etag)) return;
  }
  throw new Error("Ledger overlay is busy; retry the edit");
}

/**
 * Reads saved owner edits. Only absent configuration or a missing document yields
 * an empty overlay. Configured storage/parse failures throw so callers preserve
 * their last successful display rather than show the saved edits as missing.
 * An injected store is always read, including in tests without Blob credentials.
 */
export async function readLedgerOverrides(
  store?: LedgerOverrideStore,
): Promise<LedgerOverrides> {
  if (!store && !process.env.BLOB_READ_WRITE_TOKEN) return emptyOverrides();
  return (await (store ?? createLedgerOverrideStore()).read()).overrides;
}

/**
 * Persists the submitted manual fields for one day on the Vercel deployment.
 *
 * Preconditions: `day` is a valid local day and `fields` contains at least one
 * already-validated manual field. Postcondition: later snapshot reads merge the
 * fields for that day; capture-owned values are not accepted by this interface.
 * Side effect: conditionally replaces only the private overlay document; conflicts
 * rebase this patch on the latest saved edits. Exhaustion or storage failure throws.
 */
export function saveLedgerDayOverride(
  day: string,
  fields: LedgerDayOverride,
  store = createLedgerOverrideStore(),
): Promise<void> {
  return updateOverrides(store, (current) => {
    current.days[day] = { ...current.days[day], ...fields };
  });
}

/**
 * Persists an effective-dated weekly goal on the Vercel deployment.
 *
 * Preconditions: `weekStart` is a displayed Monday and the goal has passed the
 * route's bounds checks. Postcondition: this goal applies from that Monday
 * forward until another saved overlay goal takes effect.
 */
export function saveLedgerWeekOverride(
  weekStart: string,
  goal: LedgerWeekOverride,
  store = createLedgerOverrideStore(),
): Promise<void> {
  return updateOverrides(store, (current) => {
    current.weeks[weekStart] = goal;
  });
}

/**
 * Applies persisted owner edits to a newly published ledger and recomputes all
 * derived scores, week totals, charts, and streaks through `assembleLedger`.
 *
 * Preconditions: `data` is a valid assembled ledger; overlay values have passed
 * `parseOverrides` or the caller owns equivalent validation. Postcondition: the
 * returned object is a new complete ledger, with hours/commits/merges unchanged
 * and only manual fields and effective goals overlaid. Input is not mutated.
 */
export function applyLedgerOverrides(
  data: LedgerData,
  overrides: LedgerOverrides,
): LedgerData {
  if (
    Object.keys(overrides.days).length === 0 &&
    Object.keys(overrides.weeks).length === 0
  ) {
    return data;
  }

  const sortedWeekOverrides = Object.entries(overrides.weeks).sort(
    ([left], [right]) => left.localeCompare(right),
  );
  const weeklyGoals: WeeklyGoal[] = ledgerWeeklyGoals(data).map((published) => {
    let goal = published;
    for (const [weekStart, override] of sortedWeekOverrides) {
      if (weekStart <= published.weekStart) {
        goal = { ...override, weekStart: published.weekStart };
      }
    }
    return goal;
  });
  return reassembleLedger(data, overrides.days, weeklyGoals);
}

export const ledgerOverrideLimits = { maxDays: LEDGER_WEEKS * 7 } as const;
