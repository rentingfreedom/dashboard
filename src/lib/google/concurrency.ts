export class ConcurrencyConflictError extends Error {
  conflictFields: string[];

  constructor(conflictFields: string[]) {
    super(
      `This record was changed by someone else (${conflictFields.join(", ")}). Refresh and try again.`
    );
    this.name = "ConcurrencyConflictError";
    this.conflictFields = conflictFields;
  }
}

/**
 * Compares the freshly-read record against the values the client last saw.
 * Only checks fields present in `expected` — untouched fields never conflict.
 */
export function checkConflicts<T extends object>(
  current: T,
  expected: Partial<T> | undefined
): void {
  if (!expected) return;
  const conflicts = Object.entries(expected).filter(
    ([key, val]) => current[key as keyof T] !== val
  );
  if (conflicts.length > 0) {
    throw new ConcurrencyConflictError(conflicts.map(([key]) => key));
  }
}
