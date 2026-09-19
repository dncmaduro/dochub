import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { AuthPrincipal } from './auth.types.js';
import type { AuthenticatedRequest } from './access-token.guard.js';

export const CurrentAuth = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthPrincipal | undefined => {
    return context.switchToHttp().getRequest<AuthenticatedRequest>().auth;
  },
);
