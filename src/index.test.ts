import { assertEquals, assertExists } from '@std/assert';
import { afterAll, beforeAll, describe, it } from '@std/testing/bdd';
import { startEmulator } from '../scripts/start-emulator.ts';
import { app } from './index.ts';

const ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
const SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const BUCKET = 'nx-cloud';
const TOKEN = 'test-token';

type Env = {
  NX_CACHE_ACCESS_TOKEN: string;
  AWS_REGION: string;
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
  S3_BUCKET_NAME: string;
  S3_ENDPOINT_URL: string;
};

async function sha256(data: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

describe('Cache server routes', () => {
  let endpoint: string;
  let emulator: { url: string; close(): Promise<void> };

  beforeAll(async () => {
    emulator = await startEmulator({ port: 4566, bucket: BUCKET });
    endpoint = emulator.url;
  });

  afterAll(async () => {
    await emulator.close();
  });

  async function makeRequest(
    method: string,
    path: string,
    headers: Record<string, string> = {},
    body?: Uint8Array,
    env?: Env,
  ) {
    const req = new Request(`http://localhost${path}`, {
      method,
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        ...headers,
      },
      body: body as BodyInit | undefined,
    });

    return await app.fetch(
      req,
      env ?? {
        NX_CACHE_ACCESS_TOKEN: TOKEN,
        AWS_REGION: 'us-east-1',
        AWS_ACCESS_KEY_ID: ACCESS_KEY_ID,
        AWS_SECRET_ACCESS_KEY: SECRET_ACCESS_KEY,
        S3_BUCKET_NAME: BUCKET,
        S3_ENDPOINT_URL: endpoint,
      },
    );
  }

  // Config for the multipart test: the real S3 bucket from the environment,
  // not the emulator. An empty S3_ENDPOINT_URL means "AWS default endpoint".
  function realS3Env(): Env {
    const required = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'] as const;
    for (const name of required) {
      if (!Deno.env.get(name)) {
        throw new Error(`TEST_MULTIPART=1 requires ${name} to be set`);
      }
    }

    const endpointUrl = Deno.env.get('S3_ENDPOINT_URL');

    return {
      NX_CACHE_ACCESS_TOKEN: TOKEN,
      AWS_REGION: Deno.env.get('AWS_REGION') || 'us-east-1',
      AWS_ACCESS_KEY_ID: Deno.env.get('AWS_ACCESS_KEY_ID')!,
      AWS_SECRET_ACCESS_KEY: Deno.env.get('AWS_SECRET_ACCESS_KEY')!,
      S3_BUCKET_NAME: Deno.env.get('S3_BUCKET_NAME') || BUCKET,
      S3_ENDPOINT_URL: endpointUrl ?? '',
    };
  }

  it('PUT /v1/cache/{hash} - Success', async () => {
    const hash = crypto.randomUUID();
    const payload = Deno.readFileSync('./src/index.ts');

    const response = await makeRequest(
      'PUT',
      `/v1/cache/${hash}`,
      {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(payload.byteLength),
      },
      payload,
    );

    assertEquals(response.status, 200);
    const body = await response.text();
    assertEquals(body, 'Successfully uploaded');
  });

  // Artifacts over the 5 MB part size take the multipart path, which
  // emulate.dev does not implement (CreateMultipartUpload 404s). Run this
  // against a real S3 bucket with TEST_MULTIPART=1 to exercise it.
  const multipartIt = Deno.env.get('TEST_MULTIPART') === '1' ? it : it.ignore;

  multipartIt(
    'PUT+GET /v1/cache/{hash} - Multipart-sized artifact (real S3)',
    async () => {
      const env = realS3Env();
      const hash = `multipart-test-${crypto.randomUUID()}`;
      const payload = new Uint8Array(12 * 1024 * 1024);
      for (let i = 0; i < payload.length; i++) {
        payload[i] = i % 251;
      }

      const putResponse = await makeRequest(
        'PUT',
        `/v1/cache/${hash}`,
        {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(payload.byteLength),
        },
        payload,
        env,
      );

      assertEquals(putResponse.status, 200);
      assertEquals(await putResponse.text(), 'Successfully uploaded');

      const getResponse = await makeRequest(
        'GET',
        `/v1/cache/${hash}`,
        {},
        undefined,
        env,
      );
      assertEquals(getResponse.status, 200);

      const downloaded = new Uint8Array(await getResponse.arrayBuffer());
      assertEquals(downloaded.byteLength, payload.byteLength);
      assertEquals(await sha256(downloaded), await sha256(payload));

      console.log(
        `multipart test object left in bucket: ${env.S3_BUCKET_NAME}/${hash}`,
      );
    },
  );

  it('PUT /v1/cache/{hash} - Missing Content-Length', async () => {
    const hash = crypto.randomUUID();

    const response = await makeRequest(
      'PUT',
      `/v1/cache/${hash}`,
      { 'Content-Type': 'application/octet-stream' },
      Deno.readFileSync('./src/index.ts'),
    );

    assertEquals(response.status, 411);
    const body = await response.text();
    assertEquals(body, 'Content-Length header is required');
  });

  it('PUT /v1/cache/{hash} - Unauthorized', async () => {
    const hash = crypto.randomUUID();

    const response = await makeRequest(
      'PUT',
      `/v1/cache/${hash}`,
      {
        'Authorization': 'Bearer wrong-token',
        'Content-Length': '10',
      },
      Deno.readFileSync('./src/index.ts'),
    );

    assertEquals(response.status, 401);
    const body = await response.text();
    assertEquals(body, 'Missing or invalid authentication token');
  });

  it('GET /v1/cache/{hash} - Success', async () => {
    const hash = crypto.randomUUID();

    await makeRequest('PUT', `/v1/cache/${hash}`, {
      'Content-Length': '10',
    }, Deno.readFileSync('./src/index.ts'));

    const response = await makeRequest('GET', `/v1/cache/${hash}`);

    assertEquals(response.status, 200);
    assertExists(response.headers.get('content-type'));

    const body = await response.text();
    assertEquals(body, Deno.readTextFileSync('./src/index.ts'));
  });

  it('GET /v1/cache/{hash} - Unauthorized', async () => {
    const hash = crypto.randomUUID();

    const response = await makeRequest(
      'GET',
      `/v1/cache/${hash}`,
      { 'Authorization': 'Bearer wrong-token' },
    );

    assertEquals(response.status, 401);
    const body = await response.text();
    assertEquals(body, 'Missing or invalid authentication token');
  });

  it('GET /v1/cache/{hash} - Not Found', async () => {
    const hash = crypto.randomUUID();

    const response = await makeRequest('GET', `/v1/cache/${hash}`);

    assertEquals(response.status, 404);
    const body = await response.text();
    assertEquals(body, 'The record was not found');
  });
});
