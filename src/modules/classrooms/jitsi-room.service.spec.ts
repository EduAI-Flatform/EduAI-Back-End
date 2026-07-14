import { JitsiRoomService } from './jitsi-room.service';

describe('JitsiRoomService', () => {
  it('generates safe EduAI room names without using raw links', () => {
    const service = new JitsiRoomService();

    const roomName = service.generateRoomName(
      '11111111-2222-4333-8444-555555555555',
      'Live AI / Workshop!',
      'abcdef12-3456-4789-9123-abcdefabcdef',
    );

    expect(roomName).toBe('eduai-11111111-live-ai-workshop-abcdef123456');
    expect(roomName).not.toContain('/');
    expect(roomName).not.toContain(' ');
    expect(service.buildMeetingUrl(roomName)).toBe(
      'https://meet.jit.si/eduai-11111111-live-ai-workshop-abcdef123456',
    );
  });
});
