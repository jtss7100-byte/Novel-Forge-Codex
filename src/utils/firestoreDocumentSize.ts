import {
  Bytes, DocumentReference, FieldValue, GeoPoint, Timestamp, VectorValue, serverTimestamp,
} from 'firebase/firestore';

const encoder = new TextEncoder();
const warningBytes = 700 * 1024;
const blockingBytes = 900 * 1024;

export class FirestoreDocumentTooLargeError extends Error {
  readonly code = 'DOCUMENT_TOO_LARGE';

  constructor(readonly estimatedBytes: number) {
    super(`[DOCUMENT_TOO_LARGE] 문서 크기 예상치 ${estimatedBytes.toLocaleString()}바이트가 안전 한도를 넘었습니다. 원고를 수정하거나 나누어 다시 저장하세요.`);
  }
}

const fieldNameBytes = (name: string) => encoder.encode(name).byteLength + 1;
const documentNameBytes = (path: string) => path.split('/').reduce((sum, part) => sum + fieldNameBytes(part), 16);

function fieldBytes(value: unknown, depth: number): number {
  if (depth > 20) throw new Error('[FIRESTORE_FIELD_DEPTH] 필드 중첩 한도를 초과했습니다.');
  if (value === null || typeof value === 'boolean') return 1;
  if (typeof value === 'string') return fieldNameBytes(value);
  if (typeof value === 'number' || value instanceof Timestamp || value instanceof Date) return 8;
  if (value instanceof FieldValue && value.isEqual(serverTimestamp())) return 8;
  if (value instanceof Bytes) return value.toUint8Array().byteLength;
  if (value instanceof VectorValue) return value.toArray().length * 8 + 32;
  if (value instanceof GeoPoint) return 16;
  if (value instanceof DocumentReference) return documentNameBytes(value.path);
  if (Array.isArray(value)) {
    return value.reduce<number>((total, item) => total + fieldBytes(item, depth + 1), 0);
  }
  if (value && typeof value === 'object' &&
      (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return mapBytes(value as Record<string, unknown>, depth);
  }
  throw new Error('[FIRESTORE_UNSUPPORTED_FIELD] 문서 크기를 추정할 수 없는 필드 형식입니다.');
}

function mapBytes(data: Record<string, unknown>, depth: number): number {
  return Object.entries(data).reduce(
    (sum, [key, value]) => sum + fieldNameBytes(key) + fieldBytes(value, depth + 1), 32,
  );
}

/** Estimate document storage, excluding index entries and Commit request overhead. */
export function estimateFirestoreDocument(path: string, data: Record<string, unknown>) {
  const estimatedBytes = documentNameBytes(path) + mapBytes(data, 0);
  const level = estimatedBytes >= blockingBytes ? 'BLOCKED' : estimatedBytes >= warningBytes ? 'WARNING' : 'OK';
  return { estimatedBytes, level } as const;
}

export function assertFirestoreDocumentFits(path: string, data: Record<string, unknown>): void {
  const estimate = estimateFirestoreDocument(path, data);
  if (estimate.level === 'BLOCKED') throw new FirestoreDocumentTooLargeError(estimate.estimatedBytes);
  if (estimate.level === 'WARNING') console.warn('Firestore document size warning', { estimatedBytes: estimate.estimatedBytes });
}
