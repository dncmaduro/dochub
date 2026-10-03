import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

/** Prevents unknown implementation errors from disclosing SQL, paths, or secrets. */
@Catch()
export class ProductionExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProductionExceptionFilter.name);

  constructor(private readonly production: boolean) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const response = context.getResponse<Response>();
    const request = context.getRequest<Request>();
    if (exception instanceof HttpException) {
      response.status(exception.getStatus()).json(exception.getResponse());
      return;
    }
    // Deliberately avoid serializing or logging unknown error values in
    // production: they commonly contain database URLs, paths, or provider data.
    if (this.production)
      this.logger.error(`Unhandled ${request.method} ${request.path}`);
    else
      this.logger.error(
        `Unhandled ${request.method} ${request.path}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
    });
  }
}
