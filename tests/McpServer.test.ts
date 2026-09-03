/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import {afterEach, describe, it} from 'node:test';

import sinon from 'sinon';

import {parser} from '../src/config/mcp-options.js';
import {McpServer} from '../src/index.js';
import {ClearcutLogger} from '../src/telemetry/ClearcutLogger.js';
import {FilePersistence} from '../src/telemetry/persistence.js';
import {WatchdogClient} from '../src/telemetry/WatchdogClient.js';

describe('McpServer', () => {
  afterEach(() => {
    sinon.restore();
    ClearcutLogger.resetForTesting();
  });

  it('keeps the telemetry logger that is already initialized', async () => {
    const logger = ClearcutLogger.initialize({
      persistence: sinon.createStubInstance(FilePersistence, {
        loadState: Promise.resolve({lastActive: ''}),
      }),
      appVersion: '0.0.0',
      watchdogClient: sinon.createStubInstance(WatchdogClient),
    });
    const args = parser('0.0.0', ['node', 'main.js'], {})
      .exitProcess(false)
      .parseSync();
    assert.strictEqual(args.usageStatistics, true);

    const first = await McpServer.from(args);
    const second = await McpServer.from(args);

    assert.strictEqual(ClearcutLogger.get(), logger);
    await first.close();
    await second.close();
  });
});
