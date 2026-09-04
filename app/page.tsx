import { Dashboard } from "@/components/Dashboard";
import { CodePulse } from "@/components/CodePulse";
import { getDashboardData } from "@/lib/dashboard";
import { isMirrorHost, readMirror } from "@/lib/mirror";
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
    const snapshot = await readMirror(day);
    if (snapshot) {
      return (
        <Dashboard
          data={snapshot.data}
          mirror={{
            publishedAt: snapshot.publishedAt,
          }}
        />
      );
    }
    return (
      <main className="mx-auto max-w-5xl px-5 py-10">
        <div className="mb-6"><CodePulse selectedDay={day && isValidDayKey(day) ? day : undefined} /></div>
        <h1 className="text-xl font-medium">{day && isValidDayKey(day) ? `Capture history for ${day} is unavailable` : "Capture data is temporarily unavailable"}</h1>
        <p className="mt-3 text-sm text-muted-foreground">The deployed calendar keeps 30 days of captured images. Missing dates are never replaced with today's data.</p>
        <div className="mt-5 flex gap-5 text-sm"><Link href="/" className="underline">Today</Link><Link href="/ledger" className="underline">Open Ledger</Link></div>
      </main>
    );
  }

  const dashboard = await getDashboardData(new Date(), day);
  return <Dashboard data={dashboard} />;
}
