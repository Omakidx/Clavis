import { LIMITS } from '@shared/api-contract/limits';

// Placeholder page: real dashboard pages arrive in P3 (docs/clavis-sync-design.md §10).
export function App() {
  return (
    <main>
      <h1>Clavis</h1>
      <p>The Clavis web dashboard is coming soon.</p>
      <p className="muted">
        Cloud storage per account: up to {Math.round(LIMITS.quotaBytes / 1024 / 1024)} MiB.
      </p>
    </main>
  );
}
