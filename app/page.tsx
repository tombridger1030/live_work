import { Dashboard } from "@/components/Dashboard";
import { getDashboardData } from "@/lib/dashboard";
import { captureFreshnessForMirror, captureHealthForMirror, isMirrorHost, readHomeMirror } from "@/lib/mirror";
import Link from "next/link";
import { isValidDayKey } from "@/lib/time";

export const dynamic = "force-dynamic";
export const revalidate = 15;

/**
 * On the Mac this is the live dashboard, read straight from the local store.
 *
 * On the deployment there is no store to read, so it serves the copy the Mac
 * published (lib/mirror.ts). That is the whole point of the deployment now: the
 * link has to answer even when the Mac is asleep. The copy supports owner
 * corrections and historical browsing without depending on the Mac's address.
 */
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ day?: string }>;
}) {
  const { day } = await searchParams;

  if (isMirrorHost()) {
    const { snapshot, missingDay } = await readHomeMirror(day);
    if (snapshot) {
      return (
        <>
          {missingDay ? (
            <section role="status" className="mx-auto mt-5 max-w-5xl px-5">
              <div className="rounded-2xl bg-amber-500/10 p-4 outline outline-1 -outline-offset-1 outline-amber-500/25">
                <h1 className="text-balance text-base font-medium text-amber-100">No captures have synced for today.</h1>
                <p className="mt-1 text-pretty text-sm leading-6 text-amber-100/75">Showing your last saved day, {snapshot.data.viewDayLabel}. These images and totals belong to that date.</p>
                <p className="mt-1 text-pretty text-sm leading-6 text-amber-100/75">Check that the capture Mac is awake and its camera and storage drive are connected. Your saved history and ledger are still available.</p>
                <Link href="/ledger" className="mt-3 inline-flex min-h-10 items-center rounded-lg bg-amber-100/10 px-3 text-sm text-amber-100 transition-transform active:scale-[0.96]">Open ledger</Link>
              </div>
            </section>
          ) : null}
        <Dashboard
          data={snapshot.data}
          mirror={{
            awaitingToday: Boolean(missingDay),
            publishedAt: snapshot.publishedAt,
            captureHealth: captureHealthForMirror(snapshot),
            captureFreshness: captureFreshnessForMirror(snapshot),
          }}
        />
        </>
      );
    }
    return (
      <main className="mx-auto max-w-5xl px-5 py-10">
        <h1 className="text-balance text-xl font-medium">{day && isValidDayKey(day) ? `No saved captures for ${day}` : "No saved captures are available"}</h1>
        <p className="mt-3 text-pretty text-sm leading-6 text-muted-foreground">Check that the capture Mac is awake and its camera and storage drive are connected. The ledger remains available while captures are offline.</p>
        <div className="mt-5 flex gap-5 text-sm"><Link href="/" className="underline">Today</Link><Link href="/ledger" className="underline">Open Ledger</Link></div>
      </main>
    );
  }

  const dashboard = await getDashboardData(new Date(), day);
  return <Dashboard data={dashboard} />;
}
