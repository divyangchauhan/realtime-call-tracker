/**
 * End-to-end integration test for ApiKeyAuthGuard.
 *
 * Builds a minimal NestJS testing app with:
 *  - A protected GET /protected route (uses @CurrentApiKey to return the key payload)
 *  - A public  GET /open   route (uses @Public())
 *
 * The ApiKey TypeORM repository is replaced by a mock so no real database is needed.
 */
import { Controller, Get, INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { ApiKey } from '../database/entities/api-key.entity';
import { ApiKeyAuthGuard } from './api-key-auth.guard';
import { RequestApiKey } from './auth.types';
import { CurrentApiKey } from './current-api-key.decorator';
import { Public } from './public.decorator';

// ---------------------------------------------------------------------------
// Minimal test controllers
// ---------------------------------------------------------------------------

@Public()
@Controller()
class OpenController {
  @Get('open')
  open() {
    return { ok: true };
  }
}

@Controller()
class ProtectedController {
  @Get('protected')
  protected(@CurrentApiKey() apiKey: RequestApiKey) {
    // Return the key payload injected by the guard so we can assert on it.
    return apiKey;
  }
}

// ---------------------------------------------------------------------------
// Shared fixture data
// ---------------------------------------------------------------------------

const GOOD_KEY_ROW: Partial<ApiKey> = {
  id: 'e2e-uuid',
  name: 'e2e-key',
  keyHash: 'ignored-in-mock',
  maxConcurrent: 3,
  maxCps: 7,
  isActive: true,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ApiKeyAuthGuard (e2e)', () => {
  let app: INestApplication;
  let findOneMock: jest.Mock;

  beforeAll(async () => {
    findOneMock = jest.fn();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [OpenController, ProtectedController],
      providers: [
        // Guard under test
        ApiKeyAuthGuard,
        // Register as global guard within this test module
        { provide: APP_GUARD, useClass: ApiKeyAuthGuard },
        // Mock the ApiKey repository — no real DB connection
        {
          provide: getRepositoryToken(ApiKey),
          useValue: { findOne: findOneMock },
        },
      ],
    }).compile();

    app = module.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    findOneMock.mockReset();
  });

  // ── Public route ───────────────────────────────────────────────────────────

  it('GET /open → 200 without any Authorization header', () => {
    return request(app.getHttpServer()).get('/open').expect(200).expect({ ok: true });
  });

  // ── Missing header on protected route ─────────────────────────────────────

  it('GET /protected without header → 401', () => {
    return request(app.getHttpServer()).get('/protected').expect(401);
  });

  // ── Invalid key ───────────────────────────────────────────────────────────

  it('GET /protected with an unknown key → 401', () => {
    findOneMock.mockResolvedValue(null);

    return request(app.getHttpServer())
      .get('/protected')
      .set('Authorization', 'Bearer wrong-key')
      .expect(401);
  });

  // ── Valid key ─────────────────────────────────────────────────────────────

  it('GET /protected with a valid key → 200 and body equals the RequestApiKey payload', async () => {
    findOneMock.mockResolvedValue(GOOD_KEY_ROW);

    const res = await request(app.getHttpServer())
      .get('/protected')
      .set('Authorization', 'Bearer good-key')
      .expect(200);

    expect(res.body).toEqual({
      id: GOOD_KEY_ROW.id,
      name: GOOD_KEY_ROW.name,
      maxConcurrent: GOOD_KEY_ROW.maxConcurrent,
      maxCps: GOOD_KEY_ROW.maxCps,
    });
  });

  // ── Verify the mock was called with isActive filter ───────────────────────

  it('passes isActive: true in the repository query for a protected route', async () => {
    findOneMock.mockResolvedValue(GOOD_KEY_ROW);

    await request(app.getHttpServer())
      .get('/protected')
      .set('Authorization', 'Bearer good-key')
      .expect(200);

    expect(findOneMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ isActive: true }) }),
    );
  });
});
