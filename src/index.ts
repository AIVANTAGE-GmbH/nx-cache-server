import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { logger } from 'hono/logger';

import {
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Upload } from '@aws-sdk/lib-storage';

// 5 MB is the S3 multipart minimum; with queueSize 1 an upload holds roughly
// one part in memory regardless of artifact size.
const UPLOAD_PART_SIZE = 5 * 1024 * 1024;
const UPLOAD_QUEUE_SIZE = 1;

export const app = new Hono<{
  Bindings: {
    NX_CACHE_ACCESS_TOKEN: string;
    AWS_REGION: string;
    AWS_ACCESS_KEY_ID: string;
    AWS_SECRET_ACCESS_KEY: string;
    S3_BUCKET_NAME: string;
    S3_ENDPOINT_URL: string;
  };
  Variables: {
    s3: S3Client;
  };
}>();

// Reuse a single S3Client (and its connection pool) instead of allocating one
// per request. Keyed by config so tests can pass different bindings.
const s3Clients = new Map<string, S3Client>();

app.use(async (c, next) => {
  const key = JSON.stringify([
    c.env.AWS_REGION,
    c.env.S3_ENDPOINT_URL,
    c.env.AWS_ACCESS_KEY_ID,
    c.env.AWS_SECRET_ACCESS_KEY,
  ]);

  let s3 = s3Clients.get(key);
  if (!s3) {
    s3 = new S3Client({
      region: c.env.AWS_REGION,
      // Empty/unset means the default AWS endpoint for the region.
      endpoint: c.env.S3_ENDPOINT_URL || undefined,
      credentials: {
        accessKeyId: c.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: c.env.AWS_SECRET_ACCESS_KEY,
      },
      forcePathStyle: true,
    });
    s3Clients.set(key, s3);
  }

  c.set('s3', s3);

  await next();
});

const auth = () =>
  createMiddleware(async (c, next) => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return new Response('Missing or invalid authentication token', {
        status: 401,
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    const token = authHeader.split(' ')[1];

    if (token !== c.env.NX_CACHE_ACCESS_TOKEN) {
      return new Response('Missing or invalid authentication token', {
        status: 401,
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    await next();
  });

app.use(logger());

app.get('/health', () => {
  return new Response('OK', {
    status: 200,
    headers: { 'Content-Type': 'text/plain' },
  });
});

app.put('/v1/cache/:hash', auth(), async (c) => {
  try {
    const hash = c.req.param('hash');

    const contentLength = c.req.header('Content-Length');
    if (contentLength === undefined || Number.isNaN(Number(contentLength))) {
      return new Response('Content-Length header is required', {
        status: 411,
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    try {
      await c.get('s3').send(
        new HeadObjectCommand({
          Bucket: c.env.S3_BUCKET_NAME,
          Key: hash,
        }),
      );

      return new Response('Cannot override an existing record', {
        status: 409,
        headers: { 'Content-Type': 'text/plain' },
      });
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'NotFound') {
        // Do nothing
      } else {
        console.error('Upload error:', error);
        return new Response('Internal server error', {
          status: 500,
          headers: { 'Content-Type': 'text/plain' },
        });
      }
    }

    // Stream the request body straight to S3 — buffering the whole artifact
    // (arrayBuffer()) put a full copy in off-heap memory per concurrent upload.
    const upload = new Upload({
      client: c.get('s3'),
      params: {
        Bucket: c.env.S3_BUCKET_NAME,
        Key: hash,
        Body: c.req.raw.body ?? new Uint8Array(),
      },
      partSize: UPLOAD_PART_SIZE,
      queueSize: UPLOAD_QUEUE_SIZE,
    });

    await upload.done();

    return new Response('Successfully uploaded', {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    });
  } catch (error: unknown) {
    console.error('Upload error:', error);
    return new Response('Internal server error', {
      status: 500,
      headers: { 'Content-Type': 'text/plain' },
    });
  }
});

app.get('/v1/cache/:hash', auth(), async (c) => {
  try {
    const hash = c.req.param('hash');

    const command = new GetObjectCommand({
      Bucket: c.env.S3_BUCKET_NAME,
      Key: hash,
    });

    const url = await getSignedUrl(c.get('s3'), command, {
      expiresIn: 18000,
    });

    const response = await fetch(url);

    if (!response.ok) {
      console.error('Download error:', response.statusText);

      await response.body?.cancel();

      if (response.status === 404) {
        return new Response('The record was not found', {
          status: 404,
          headers: { 'Content-Type': 'text/plain' },
        });
      }

      return new Response('Access forbidden', {
        status: 403,
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    const headers = new Headers({
      'Content-Type': 'application/octet-stream',
    });
    const contentLength = response.headers.get('Content-Length');
    if (contentLength) {
      headers.set('Content-Length', contentLength);
    }

    return new Response(response.body, {
      status: 200,
      headers,
    });
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'NoSuchKey') {
      return new Response('The record was not found', {
        status: 404,
        headers: { 'Content-Type': 'text/plain' },
      });
    }
    console.error('Download error:', error);
    return new Response('Internal server error', {
      status: 500,
      headers: { 'Content-Type': 'text/plain' },
    });
  }
});

if (import.meta.main) {
  const port = parseInt(Deno.env.get('PORT') || '3000');

  const certPath = Deno.env.get('TLS_CERT_PATH');
  const keyPath = Deno.env.get('TLS_KEY_PATH');

  if (Boolean(certPath) !== Boolean(keyPath)) {
    console.error(
      'TLS misconfiguration: TLS_CERT_PATH and TLS_KEY_PATH must be set together',
    );
    Deno.exit(1);
  }

  let tls = {};
  if (certPath && keyPath) {
    try {
      tls = {
        cert: Deno.readTextFileSync(certPath),
        key: Deno.readTextFileSync(keyPath),
      };
    } catch (e) {
      console.error(
        `TLS misconfiguration: cannot read cert/key: ${
          e instanceof Error ? e.message : e
        }`,
      );
      Deno.exit(1);
    }
  }

  console.log(`Server running on port ${port}${certPath ? ' over HTTPS' : ''}`);

  Deno.serve({ port, ...tls }, (req) =>
    app.fetch(req, {
      NX_CACHE_ACCESS_TOKEN: Deno.env.get('NX_CACHE_ACCESS_TOKEN'),
      AWS_REGION: Deno.env.get('AWS_REGION') || 'us-east-1',
      AWS_ACCESS_KEY_ID: Deno.env.get('AWS_ACCESS_KEY_ID'),
      AWS_SECRET_ACCESS_KEY: Deno.env.get('AWS_SECRET_ACCESS_KEY'),
      S3_BUCKET_NAME: Deno.env.get('S3_BUCKET_NAME') || 'nx-cloud',
      S3_ENDPOINT_URL: Deno.env.get('S3_ENDPOINT_URL'),
    }));
}
