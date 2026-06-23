import { Dashboard } from "@/components/Dashboard";
import { getDashboardData } from "@/lib/dashboard";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function Home({ searchParams }: { searchParams: Promise<{ day?: string }> }) {
  const { day } = await searchParams;
  const dashboard = await getDashboardData(new Date(), day);
  return <Dashboard data={dashboard} />;
}
