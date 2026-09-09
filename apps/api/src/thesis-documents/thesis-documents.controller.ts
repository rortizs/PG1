import {
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Req,
  Res,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { handleApiRequest } from '../api-contract.mjs';
import { SessionGuard } from '../auth/session.guard.js';
import type { HttpRequest, HttpResponse } from '../http-types.js';

/** Minimal structural shape of the multer in-memory file this route needs. */
interface UploadedMulterFile {
  originalname: string;
  mimetype: string;
  buffer: Uint8Array;
  size: number;
}

/** Minimal structural shape of the headers this controller needs. */
interface RequestWithHeaders {
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Real NestJS controller for thesis-document routes.
 *
 * Every method delegates to the existing pure `handleApiRequest` (which in
 * turn delegates to `upload-service.mjs`) — no upload/storage logic is
 * re-implemented here.
 */
@Controller('api/v1/thesis-documents')
@UseGuards(SessionGuard)
export class ThesisDocumentsController {
  readonly routes = [
    'POST /api/v1/thesis-documents',
    'GET /api/v1/thesis-documents',
    'POST /api/v1/thesis-documents/{document_id}/review-runs',
  ];

  @Post()
  @UseInterceptors(FilesInterceptor('file'))
  async create(
    @UploadedFiles() files: UploadedMulterFile[] = [],
    @Headers() headers: RequestWithHeaders['headers'],
    @Res() res: HttpResponse,
  ) {
    // Always pass a real `files` array (possibly empty) so zero-file and
    // multi-file submissions hit `upload-service.mjs`'s existing "exactly
    // one file" validation instead of falling into the pure-handler's
    // no-body contract stub branch.
    const body = {
      files: files.map((file) => ({
        filename: file.originalname,
        contentType: file.mimetype,
        content: file.buffer,
        size: file.size,
      })),
    };

    const result = await handleApiRequest({
      method: 'POST',
      path: '/api/v1/thesis-documents',
      body,
      headers,
    });
    res.status(result.status).json(result.body);
  }

  @Get()
  async list(
    @Query() query: Record<string, string>,
    @Headers() headers: RequestWithHeaders['headers'],
    @Res() res: HttpResponse,
  ) {
    const result = await handleApiRequest({
      method: 'GET',
      path: '/api/v1/thesis-documents',
      query,
      headers,
    });
    res.status(result.status).json(result.body);
  }

  @Post(':documentId/review-runs')
  async createReviewRun(
    @Param('documentId') documentId: string,
    @Req() req: HttpRequest,
    @Headers() headers: RequestWithHeaders['headers'],
    @Res() res: HttpResponse,
  ) {
    const result = await handleApiRequest({
      method: 'POST',
      path: `/api/v1/thesis-documents/${encodeURIComponent(documentId)}/review-runs`,
      body: req.body ?? {},
      headers,
    });
    res.status(result.status).json(result.body);
  }
}
