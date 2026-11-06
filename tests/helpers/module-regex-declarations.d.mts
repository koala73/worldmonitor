export function moduleRegexDeclarations(source: string, arrayNames?: string[], excludeNames?: string[]): string;
export function inlineModuleRegexReferences(source: string, snippet?: string): string;
export function moduleRegexBindings(source: string): Record<string, RegExp>;
