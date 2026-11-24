function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function assertCanonicalJsonSchema(value: unknown, source: string): void {
  const properties = isRecord(value) ? value.properties : undefined;
  if (
    !isRecord(value) || value.type !== 'object' || !isRecord(properties) ||
    !Array.isArray(value.required) || value.required.length === 0 ||
    !value.required.every((field: unknown) => typeof field === 'string' && Object.hasOwn(properties, field))
  ) {
    throw new Error(`Invalid canonical schema ${source}: expected an object schema with declared required fields`);
  }
}
