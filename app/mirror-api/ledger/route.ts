// The deployed Ledger has a same-origin mutation path so Next's live-only API
// redirect cannot strand edits on the sleeping Mac.
export { GET, POST } from "@/app/api/ledger/route";
