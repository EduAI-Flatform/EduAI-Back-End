import { AppLoggerService } from '../../common/logging/app-logger.service';
import {
  DisabledNotificationEmailProvider,
  resolveNotificationEmailProvider,
  PreviewNotificationEmailProvider,
  ResendNotificationEmailProvider,
} from './notification-email.provider';

describe('notification email providers', () => {
  afterEach(() => jest.restoreAllMocks());

  it('keeps disabled delivery as a no-op', async () => {
    const provider = new DisabledNotificationEmailProvider();

    await expect(
      provider.send({
        category: 'assignment',
        html: '<p>Due tomorrow</p>',
        subject: 'Assignment due',
        text: 'Due tomorrow',
        to: 'learner@example.test',
      }),
    ).resolves.toEqual({ status: 'disabled' });
  });

  it('writes a development preview without recipient or body data', async () => {
    const entries: string[] = [];
    const logger = new AppLoggerService((entry) => entries.push(entry));
    const provider = new PreviewNotificationEmailProvider(logger);

    await expect(
      provider.send({
        category: 'certificate',
        html: '<p>Certificate ready</p>',
        subject: 'Certificate ready',
        text: 'Certificate ready',
        to: 'learner@example.test',
      }),
    ).resolves.toEqual({ status: 'previewed' });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toContain('notification_email_preview');
    expect(entries[0]).toContain('certificate');
    expect(entries[0]).not.toContain('learner@example.test');
    expect(entries[0]).not.toContain('Certificate ready');
  });

  it('sends through Resend using typed configuration only', async () => {
    const fetcher = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: true } as Response);
    const provider = new ResendNotificationEmailProvider(
      {
        email: {
          from: 'noreply@example.test',
          provider: 'resend',
          resendApiKey: 'test-key',
        },
      } as never,
    );

    await expect(
      provider.send({
        category: 'grade',
        html: '<p>Grade published</p>',
        subject: 'Grade published',
        text: 'Grade published',
        to: 'learner@example.test',
      }),
    ).resolves.toEqual({ status: 'sent' });

    expect(fetcher).toHaveBeenCalledWith(
      'https://api.resend.com/emails',
      expect.objectContaining({
        body: JSON.stringify({
          from: 'noreply@example.test',
          html: '<p>Grade published</p>',
          subject: 'Grade published',
          text: 'Grade published',
          to: ['learner@example.test'],
        }),
        method: 'POST',
      }),
    );
  });

  it('rejects a provider failure without exposing response content', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: false } as Response);
    const provider = new ResendNotificationEmailProvider(
      {
        email: {
          from: 'noreply@example.test',
          provider: 'resend',
          resendApiKey: 'test-key',
        },
      } as never,
    );

    await expect(
      provider.send({
        category: 'grade',
        html: '<p>Grade published</p>',
        subject: 'Grade published',
        text: 'Grade published',
        to: 'learner@example.test',
      }),
    ).rejects.toThrow('Notification email provider request failed');
  });

  it('selects the configured provider without enabling delivery by default', () => {
    const disabled = new DisabledNotificationEmailProvider();
    const preview = new PreviewNotificationEmailProvider(
      new AppLoggerService(() => undefined),
    );
    const resend = new ResendNotificationEmailProvider({} as never);

    expect(
      resolveNotificationEmailProvider(
        { email: { provider: 'disabled' } } as never,
        disabled,
        preview,
        resend,
      ),
    ).toBe(disabled);
    expect(
      resolveNotificationEmailProvider(
        { email: { provider: 'preview' } } as never,
        disabled,
        preview,
        resend,
      ),
    ).toBe(preview);
  });
});
