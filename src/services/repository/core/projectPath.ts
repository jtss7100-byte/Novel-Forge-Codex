export function firestoreProjectPath(uid: string, projectId: string): string {
  return `users/${uid}/projects/${projectId}`;
}
