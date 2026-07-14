import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

const JITSI_BASE_URL = 'https://meet.jit.si';

@Injectable()
export class JitsiRoomService {
  generateRoomName(
    courseId: string,
    sessionTitle: string,
    entropy = randomUUID(),
  ): string {
    const coursePart = this.safeToken(courseId).slice(0, 8) || 'course';
    const titlePart = this.slugify(sessionTitle).slice(0, 60) || 'session';
    const entropyPart = this.safeToken(entropy).slice(0, 12);

    return `eduai-${coursePart}-${titlePart}-${entropyPart}`;
  }

  buildMeetingUrl(roomName: string): string {
    return `${JITSI_BASE_URL}/${encodeURIComponent(roomName)}`;
  }

  private slugify(value: string): string {
    return value
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  private safeToken(value: string): string {
    return value.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  }
}
