import { MonitoringService } from './monitoring.service';

describe('MonitoringService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('is inert when monitoring is disabled', () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    new MonitoringService({ monitoring: { enabled: false }, app: { nodeEnv: 'test' } } as never)
      .capture({ code: 'ERROR', path: '/safe', statusCode: 500 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sends only the sanitized structured event when enabled', () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(new Response());
    new MonitoringService({ monitoring: { enabled: true, endpoint: 'https://monitor.example/events' }, app: { nodeEnv: 'production' } } as never)
      .capture({ code: 'ERROR', correlationId: 'request-12345678', path: '/safe', statusCode: 500 });
    expect(fetchSpy).toHaveBeenCalledWith('https://monitor.example/events', expect.objectContaining({ method: 'POST' }));
    const body = String(fetchSpy.mock.calls[0][1]?.body);
    expect(body).toContain('request-12345678');
    expect(body).not.toMatch(/password|token|cookie/i);
  });
});
