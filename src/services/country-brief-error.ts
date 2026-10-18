export class CountrySectionError extends Error {
  constructor(public readonly state: 'locked' | 'unavailable', message: string) { super(message); }
}

