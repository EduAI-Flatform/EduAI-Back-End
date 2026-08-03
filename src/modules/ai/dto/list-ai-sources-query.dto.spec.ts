import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ListAiSourcesQueryDto } from './list-ai-sources-query.dto';

describe('ListAiSourcesQueryDto', () => {
  it('normalizes a valid source filter', async () => {
    const input = plainToInstance(ListAiSourcesQueryDto, {
      sourceType: 'lesson',
      search: '  gradient  ',
    });

    await expect(validate(input)).resolves.toEqual([]);
    expect(input.search).toBe('gradient');
  });

  it('rejects unsupported source types', async () => {
    const input = plainToInstance(ListAiSourcesQueryDto, {
      sourceType: 'course',
    });

    const errors = await validate(input);
    expect(errors[0]?.constraints).toEqual(
      expect.objectContaining({ isIn: expect.any(String) }),
    );
  });
});
