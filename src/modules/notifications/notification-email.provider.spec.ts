import { AppLoggerService } from '../../common/logging/app-logger.service';
import {
  DisabledNotificationEmailProvider,
  PreviewNotificationEmailProvider,
} from './notification-email.provider';

describe('notification email providers', () => {
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
});
