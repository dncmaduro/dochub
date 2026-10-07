import { FileVersionActorType } from '@dochub/database';

export interface ActorResponse {
  type: FileVersionActorType;
  id?: string;
  displayName: string | null;
}

export interface LastModifiedResponse {
  at: Date;
  actor: ActorResponse;
}

export function actorResponse(
  type: FileVersionActorType,
  user: { id: string; displayName: string } | null | undefined,
): ActorResponse {
  return {
    type,
    ...(type === FileVersionActorType.USER && user ? { id: user.id } : {}),
    displayName:
      type === FileVersionActorType.USER ? user?.displayName || null : null,
  };
}
