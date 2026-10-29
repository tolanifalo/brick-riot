/** An expected, client-facing error: a stable code and an HTTP status. Never carries internals. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

/** Prisma's unique-constraint violation (P2002), possibly wrapped by the driver adapter. */
export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string }; meta?: { driverAdapterError?: { cause?: { code?: string; kind?: string } } } };
  return (
    e?.code === 'P2002' ||
    e?.cause?.code === '23505' ||
    e?.meta?.driverAdapterError?.cause?.kind === 'UniqueConstraintViolation' ||
    e?.meta?.driverAdapterError?.cause?.code === '23505'
  );
}

/** A CHECK constraint (e.g. a balance going negative) refused the write. */
export function isCheckViolation(err: unknown): boolean {
  const e = err as { cause?: { code?: string }; meta?: { driverAdapterError?: { cause?: { code?: string; originalCode?: string } } } };
  return (
    e?.cause?.code === '23514' ||
    e?.meta?.driverAdapterError?.cause?.code === '23514' ||
    e?.meta?.driverAdapterError?.cause?.originalCode === '23514'
  );
}
