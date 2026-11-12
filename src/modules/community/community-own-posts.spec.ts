import { CommunityService } from './community.service';
describe('own profile posts', () => {
  it('uses authenticated ownership with pagination for both private and public posts', async () => {
    const prisma = { communityPost: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(21) } };
    const result = await new CommunityService(prisma as any, {} as any).listOwnPosts('owner', 2);
    expect(prisma.communityPost.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { authorId: 'owner', deletedAt: null }, take: 10, skip: 10 }));
    expect(prisma.communityPost.count).toHaveBeenCalledWith({ where: { authorId: 'owner', deletedAt: null } });
    expect(result.totalPages).toBe(3);
  });
});
