// Authentication for the deployed Ledger must set its cookie on the Vercel
// origin; reusing the server-only session contract keeps the secret handling in
// one place.
export { POST } from "@/app/api/ledger/session/route";
