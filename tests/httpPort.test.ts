/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import type {ChildProcessByStdio} from 'node:child_process';
import {spawn} from 'node:child_process';
import type {Readable, Writable} from 'node:stream';
import {after, before, describe, it} from 'node:test';

import {executablePath} from 'puppeteer';

import {connectMcpOverHttp, disconnectMcpSession} from './utils.js';

const TOKEN = 'http-port-test-token';
const STARTUP_TIMEOUT_MS = 30_000;
const SHUTDOWN_BUDGET_MS = 10_000;
const EXIT_TIMEOUT_MS = 15_000;

type Server = ChildProcessByStdio<Writable, Readable, Readable>;

async function spawnHttpServer(): Promise<{child: Server; url: URL}> {
  const child = spawn(
    'node',
    [
      'build/src/bin/chrome-devtools-mcp.js',
      '--headless',
      '--isolated',
      '--executable-path',
      await executablePath(),
      '--http-port',
      '0',
    ],
    {
      env: {
        ...process.env,
        CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: 'true',
        CHROME_DEVTOOLS_MCP_HTTP_TOKEN: TOKEN,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  ) as Server;
  child.stdout.resume();
  const url = await new Promise<URL>((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`server did not start: ${stderr}`));
    }, STARTUP_TIMEOUT_MS);
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      const match = stderr.match(/listening on (http:\/\/\S+)\n/);
      if (match) {
        clearTimeout(timer);
        resolve(new URL(match[1]));
      }
    });
    child.once('exit', () => {
      clearTimeout(timer);
      reject(new Error(`server exited before listening: ${stderr}`));
    });
  });
  return {child, url};
}

async function waitForExit(child: Server): Promise<number> {
  const start = Date.now();
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`server did not exit within ${EXIT_TIMEOUT_MS}ms`));
    }, EXIT_TIMEOUT_MS);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(Date.now() - start);
    });
  });
}

describe('--httpPort', () => {
  let child: Server | undefined;
  let url: URL;

  function running(): Server {
    assert.ok(child, 'the server was not started');
    return child;
  }

  before(async () => {
    ({child, url} = await spawnHttpServer());
  });

  after(async () => {
    if (child && child.exitCode === null) {
      child.kill('SIGKILL');
    }
  });

  it('serves MCP over HTTP with the token from the environment', async () => {
    const session = await connectMcpOverHttp(url, TOKEN);
    try {
      const {tools} = await session.client.listTools();
      assert.ok(tools.some(tool => tool.name === 'list_pages'));
    } finally {
      await disconnectMcpSession(session);
    }
  });

  it('rejects requests without the token', async () => {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'ping'}),
    });
    assert.strictEqual(response.status, 401);
  });

  it('exits on SIGTERM with a live browser', async () => {
    const {client} = await connectMcpOverHttp(url, TOKEN);
    try {
      await client.callTool({name: 'list_pages', arguments: {}});
      const server = running();
      server.kill('SIGTERM');
      const elapsedMs = await waitForExit(server);
      assert.ok(
        elapsedMs < SHUTDOWN_BUDGET_MS,
        `SIGTERM shutdown took ${elapsedMs}ms (budget ${SHUTDOWN_BUDGET_MS}ms)`,
      );
    } finally {
      await client.close();
    }
  });
});
