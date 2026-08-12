import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AssignmentsController } from './assignments.controller';
import { AssignmentsService } from './assignments.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';

describe('Assignments OpenAPI schema', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AssignmentsController],
      providers: [{ provide: AssignmentsService, useValue: {} }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
  });

  afterAll(async () => {
    await app.close();
  });

  it('generates assignment schemas with primitive file URLs and starts listening', async () => {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('Assignments').build(),
    );

    expect(document.components?.schemas?.SubmitAssignmentDto).toEqual(
      expect.objectContaining({
        properties: expect.objectContaining({
          fileUrl: expect.objectContaining({ type: 'string', format: 'uri' }),
        }),
      }),
    );
    expect(document.components?.schemas?.SubmissionResponseDto).toEqual(
      expect.objectContaining({
        properties: expect.objectContaining({
          fileUrl: expect.objectContaining({ type: 'string', format: 'uri' }),
        }),
      }),
    );

    await expect(app.listen(0, '127.0.0.1')).resolves.toBeDefined();
  });
});
