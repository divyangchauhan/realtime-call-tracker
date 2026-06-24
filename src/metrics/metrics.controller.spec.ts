import { Test, TestingModule } from '@nestjs/testing';
import { RequestApiKey } from '../auth/auth.types';
import { CallStatus } from '../database/entities/call-status.enum';
import { MetricsResponse } from './dto/metrics-response.dto';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';

const MOCK_API_KEY: RequestApiKey = {
  id: 'api-key-id-1',
  name: 'test-key',
  maxConcurrent: 5,
  maxCps: 2,
};

const MOCK_RESPONSE: MetricsResponse = {
  api_key_id: MOCK_API_KEY.id,
  calls: {
    total: 10,
    by_status: {
      [CallStatus.QUEUED]: 0,
      [CallStatus.RINGING]: 3,
      [CallStatus.ANSWERED]: 0,
      [CallStatus.UNANSWERED]: 0,
      [CallStatus.COMPLETED]: 7,
    },
    with_recording: 4,
  },
  live: { active_calls: 2 },
  limits: { max_concurrent: MOCK_API_KEY.maxConcurrent, max_cps: MOCK_API_KEY.maxCps },
  generated_at: '2024-01-01T00:00:00.000Z',
};

describe('MetricsController', () => {
  let controller: MetricsController;
  let serviceMock: { getMetrics: jest.Mock };

  beforeEach(async () => {
    serviceMock = {
      getMetrics: jest.fn().mockResolvedValue(MOCK_RESPONSE),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [MetricsController],
      providers: [{ provide: MetricsService, useValue: serviceMock }],
    }).compile();

    controller = module.get<MetricsController>(MetricsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('delegates to MetricsService.getMetrics with the authenticated api key', async () => {
    await controller.getMetrics(MOCK_API_KEY);

    expect(serviceMock.getMetrics).toHaveBeenCalledWith(MOCK_API_KEY);
    expect(serviceMock.getMetrics).toHaveBeenCalledTimes(1);
  });

  it('returns the service result unchanged', async () => {
    const result = await controller.getMetrics(MOCK_API_KEY);

    expect(result).toBe(MOCK_RESPONSE);
  });
});
