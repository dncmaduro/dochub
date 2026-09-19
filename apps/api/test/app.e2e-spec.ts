import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module.js';
import { DatabaseService } from './../src/database/database.service.js';

describe('API authentication routes (e2e)', () => {
  let app: INestApplication<App>;
  const originalAccessTokenSecret = process.env.AUTH_ACCESS_TOKEN_SECRET;

  beforeEach(async () => {
    process.env.AUTH_ACCESS_TOKEN_SECRET = 'e2e-test-secret';
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(DatabaseService)
      .useValue({ ping: vi.fn().mockResolvedValue(undefined) })
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  it('/health (GET) reports the real-health-controller contract', () => {
    return request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect({ status: 'ok', database: 'up' });
  });

  it('/auth/refresh (POST) rejects a missing refresh cookie', () => {
    return request(app.getHttpServer()).post('/auth/refresh').expect(401);
  });

  it('/auth/logout (POST) is idempotent without a refresh cookie', () => {
    return request(app.getHttpServer()).post('/auth/logout').expect(204);
  });

  it('/admin/users (GET) rejects unauthenticated requests', () => {
    return request(app.getHttpServer()).get('/admin/users').expect(401);
  });

  afterEach(async () => {
    await app.close();
  });

  afterAll(() => {
    if (originalAccessTokenSecret === undefined) {
      delete process.env.AUTH_ACCESS_TOKEN_SECRET;
    } else {
      process.env.AUTH_ACCESS_TOKEN_SECRET = originalAccessTokenSecret;
    }
  });
});
