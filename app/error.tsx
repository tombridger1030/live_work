"use client";

// Route-segment error boundary for the whole app. When a Server Component render
// throws — most often because the database is briefly unreachable or over its
// compute quota — Next renders this instead of the raw "server-side exception"
// page. The public status page then degrades to a calm, on-brand notice with a
// retry rather than leaking an error digest to visitors.
export default function StatusError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="flex min-h-[calc(100vh-57px)] flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-lg font-medium text-foreground">Status temporarily unavailable</h1>
      <p className="max-w-sm text-sm text-muted-foreground">
        We can’t reach the desk-presence data right now. This is usually brief — please try again in a moment.
      </p>
      <button
        type="button"
        onClick={reset}
        className="rounded-md border border-border px-4 py-2 text-sm text-foreground transition-colors hover:bg-muted"
      >
        Try again
      </button>
    </main>
  );
}
