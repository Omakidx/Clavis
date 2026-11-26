/** Short-lived in-process cache of "is this refresh-token family still active" (design §2.3: at most 30 s). */
export class FamilyCache {
  private readonly entries = new Map<string, { active: boolean; until: number }>();

  constructor(
    private readonly now: () => number,
    private readonly ttlMs = 30_000,
    private readonly maxEntries = 10_000,
  ) {}

  private generation = 0;

  /** Call before a DB read; pass the result to `set` so a read that raced an eviction is not cached. */
  begin(): number {
    return this.generation;
  }

  get(familyId: string): boolean | undefined {
    const e = this.entries.get(familyId);
    if (!e) return undefined;
    if (e.until <= this.now()) {
      this.entries.delete(familyId);
      return undefined;
    }
    return e.active;
  }

  set(familyId: string, active: boolean, generation: number): void {
    if (generation !== this.generation) return; // an eviction happened after the read started
    if (this.entries.size >= this.maxEntries) this.entries.clear();
    this.entries.set(familyId, { active, until: this.now() + this.ttlMs });
  }

  /** Called on local revocation so this process stops accepting the family immediately. */
  evict(familyId: string): void {
    this.generation++;
    this.entries.set(familyId, { active: false, until: this.now() + this.ttlMs });
  }
}
