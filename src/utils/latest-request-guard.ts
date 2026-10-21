/** Tiny generation guard for suppressing completions from superseded async work. */
export class LatestRequestGuard {
  private generation = 0;

  begin(): number {
    this.generation += 1;
    return this.generation;
  }

  isCurrent(generation: number): boolean {
    return generation === this.generation;
  }
}
