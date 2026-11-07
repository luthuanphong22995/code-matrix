export type SidecarState =
  | { kind: 'not-started' }
  | { kind: 'starting' }
  | { kind: 'ready' }
  | { kind: 'indexing'; detail?: string }
  | { kind: 'failed'; cause: string };
