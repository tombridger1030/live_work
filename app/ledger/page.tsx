import { getLedgerData } from "@/lib/ledger-server";
import { Ledger } from "@/components/Ledger";
import { isMirrorHost, readLatestMirror } from "@/lib/mirror";

export const dynamic = "force-dynamic";
export const revalidate = 15;

/**
 * Serves the live local Ledger on the Mac and the latest published, editable
 * Ledger on Vercel. Browser reads and edits stay on the current origin.
 */
export default async function LedgerPage() {
  if (isMirrorHost()) {
    const snapshot = await readLatestMirror();
    if (snapshot?.ledger) {
      return (
        <Ledger
          data={snapshot.ledger}
          mirror={{
            publishedAt: snapshot.publishedAt,
          }}
        />
      );
    }
    return <main className="mx-auto max-w-5xl px-5 py-10"><h1 className="text-xl font-medium">Ledger is temporarily unavailable</h1><p className="mt-3 text-sm text-muted-foreground">The last published data could not be loaded. Reload to try again.</p></main>;
  }

  const data = await getLedgerData(new Date());
  return <Ledger data={data} />;
}
