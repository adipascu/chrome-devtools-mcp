/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import http from 'node:http';
import {after, before, describe, it} from 'node:test';

import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {CallToolResultSchema} from '@modelcontextprotocol/sdk/types.js';
import {executablePath} from 'puppeteer';

import {closeBrowser} from '../src/browser.js';
import {parser} from '../src/config/mcp-options.js';
import {HttpServer, type HttpServerOptions} from '../src/http.js';
import {McpServer} from '../src/index.js';

import {getTextContent} from './utils.js';

const TOKEN = 'http-test-token';

async function connect(
  url: URL,
  token: string | undefined = TOKEN,
): Promise<{client: Client; transport: StreamableHTTPClientTransport}> {
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: token
      ? {headers: {Authorization: `Bearer ${token}`}}
      : undefined,
  });
  const client = new Client({name: 'http-test', version: '1.0.0'});
  await client.connect(transport);
  return {client, transport};
}

async function disconnect(session: {
  client: Client;
  transport: StreamableHTTPClientTransport;
}): Promise<void> {
  await session.transport.terminateSession();
  await session.client.close();
}

async function callText(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<string> {
  const result = CallToolResultSchema.parse(
    await client.callTool({name, arguments: args}),
  );
  return result.content.map(getTextContent).join('\n');
}

function countPages(listing: string): number {
  return listing.split('\n').filter(line => /^\d+: /.test(line)).length;
}

async function withRetry<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (
        attempt === 3 ||
        !(error instanceof Error) ||
        !/time(d )?out/i.test(error.message)
      ) {
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}

function rawRequest(
  url: URL,
  options: {method: string; headers?: Record<string, string>; body?: string},
): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      url,
      {
        method: options.method,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...options.headers,
        },
      },
      response => {
        response.resume();
        response.on('end', () => resolve(response.statusCode ?? 0));
      },
    );
    request.on('error', reject);
    request.end(options.body);
  });
}

function rejectsWithStatus(status: number): (error: unknown) => boolean {
  return error => error instanceof StreamableHTTPError && error.code === status;
}

const ping = JSON.stringify({jsonrpc: '2.0', id: 1, method: 'ping'});

describe('HttpServer', () => {
  let createMcpServer: HttpServerOptions['createMcpServer'];
  let server: HttpServer;
  let url: URL;

  before(async () => {
    const args = parser(
      '0.0.0',
      [
        'node',
        'main.js',
        '--headless',
        '--isolated',
        '--executable-path',
        await executablePath(),
        '--no-usage-statistics',
      ],
      {},
    )
      .exitProcess(false)
      .parseSync();
    createMcpServer = () => McpServer.from(args);
    server = await HttpServer.listen({
      host: '127.0.0.1',
      port: 0,
      token: TOKEN,
      createMcpServer,
    });
    url = new URL(server.url);
  });

  after(async () => {
    await server.close();
    await closeBrowser();
  });

  it('refuses to listen on a non-loopback host without a token', async () => {
    await assert.rejects(
      HttpServer.listen({host: '0.0.0.0', port: 0, createMcpServer}),
      /without a token/,
    );
  });

  it('rejects clients without the bearer token', async () => {
    await assert.rejects(connect(url, 'wrong-token'), rejectsWithStatus(401));
    assert.strictEqual(server.sessionCount, 0);
  });

  it('rejects a request with a foreign Host header', async () => {
    const status = await rawRequest(url, {
      method: 'POST',
      headers: {Host: 'evil.example', Authorization: `Bearer ${TOKEN}`},
      body: ping,
    });
    assert.strictEqual(status, 403);
  });

  it('rejects a request outside the MCP path', async () => {
    const status = await rawRequest(new URL('/other', url), {
      method: 'POST',
      headers: {Authorization: `Bearer ${TOKEN}`},
      body: ping,
    });
    assert.strictEqual(status, 404);
  });

  it('rejects a non-initialize request without a session', async () => {
    const status = await rawRequest(url, {
      method: 'POST',
      headers: {Authorization: `Bearer ${TOKEN}`},
      body: ping,
    });
    assert.strictEqual(status, 400);
  });

  it('rejects a GET without a session', async () => {
    const status = await rawRequest(url, {
      method: 'GET',
      headers: {Authorization: `Bearer ${TOKEN}`},
    });
    assert.strictEqual(status, 400);
  });

  it('shares one browser between client sessions', async () => {
    const first = await connect(url);
    const second = await connect(url);
    try {
      assert.strictEqual(server.sessionCount, 2);
      const [, listing] = await withRetry(() =>
        Promise.all([
          callText(first.client, 'list_pages'),
          callText(second.client, 'list_pages'),
        ]),
      );
      const before = countPages(listing);
      await callText(first.client, 'new_page', {url: 'about:blank'});
      const after = countPages(await callText(second.client, 'list_pages'));
      assert.strictEqual(after, before + 1);
    } finally {
      await Promise.allSettled([disconnect(first), disconnect(second)]);
    }
    assert.strictEqual(server.sessionCount, 0);
  });

  it('forgets a session once the client terminates it', async () => {
    const session = await connect(url);
    await callText(session.client, 'list_pages');
    const sessionId = session.transport.sessionId;
    assert.ok(sessionId);
    await disconnect(session);
    const status = await rawRequest(url, {
      method: 'POST',
      headers: {Authorization: `Bearer ${TOKEN}`, 'Mcp-Session-Id': sessionId},
      body: ping,
    });
    assert.strictEqual(status, 404);
    assert.strictEqual(server.sessionCount, 0);
  });

  it('refuses new sessions above maxSessions, even when they start together', async () => {
    const limited = await HttpServer.listen({
      host: '127.0.0.1',
      port: 0,
      token: TOKEN,
      maxSessions: 1,
      createMcpServer: async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
        return await createMcpServer();
      },
    });
    try {
      const attempts = await Promise.allSettled([
        connect(new URL(limited.url)),
        connect(new URL(limited.url)),
        connect(new URL(limited.url)),
      ]);
      const admitted = attempts.filter(
        attempt => attempt.status === 'fulfilled',
      );
      const refused = attempts.filter(attempt => attempt.status === 'rejected');
      assert.strictEqual(admitted.length, 1);
      assert.strictEqual(refused.length, 2);
      for (const attempt of refused) {
        assert.ok(rejectsWithStatus(503)(attempt.reason));
      }
      assert.strictEqual(limited.sessionCount, 1);
      await assert.rejects(
        connect(new URL(limited.url)),
        rejectsWithStatus(503),
      );
      for (const attempt of admitted) {
        await disconnect(attempt.value);
      }
    } finally {
      await limited.close();
    }
  });

  it('accepts every client when no token is configured', async () => {
    const open = await HttpServer.listen({
      host: '127.0.0.1',
      port: 0,
      createMcpServer,
    });
    try {
      const session = await connect(new URL(open.url), undefined);
      const {tools} = await session.client.listTools();
      assert.ok(tools.some(tool => tool.name === 'list_pages'));
      await disconnect(session);
    } finally {
      await open.close();
    }
  });
});
