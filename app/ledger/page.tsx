import { getLedgerData } from "@/lib/ledger-server";
import { Ledger } from "@/components/Ledger";
export const dynamic = "force-dynamic";
export const revalidate = 15;

export default async function LedgerPage() {
  const data = await getLedgerData(new Date());
  return <Ledger data={data} />;
}
