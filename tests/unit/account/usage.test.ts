import { describe, expect, it } from 'vitest';
import { accountStatusSchema } from '../../../lib/contracts/account';
import { FakeServer } from '../sync/fake-server';
import { createClient, createClock } from '../sync/client';

const IDLE = { state: 'idle', pending: 0, rejected: 0 };

describe('ACCOUNT_GET_STATUS usage (design 7.7)', () => {
  it('signed out: no usage and no request', async () => {
    const server = new FakeServer();
    const client = createClient(server);
    client.bind();
    const status = await client.service.getStatus();
    expect(status.signedIn).toBe(false);
    expect(status.usage).toBeUndefined();
    expect(server.accountReads).toBe(0);
  });

  it('signed in: the server count, cached briefly, refreshed on invalidate and after the TTL', async () => {
    const clock = createClock();
    const server = new FakeServer({ now: clock.now });
    const client = createClient(server, { clock });
    client.bind();
    expect((await client.service.signIn()).ok).toBe(true);
    const first = await client.service.getStatus();
    expect(first.usage).toEqual({ storageUsedBytes: 5_242_880, storageQuotaBytes: 104_857_600 });
    await client.service.getStatus();
    expect(server.accountReads).toBe(1); // cached

    server.usage = { storageUsedBytes: 9_000_000, storageQuotaBytes: 104_857_600 };
    expect((await client.service.getStatus()).usage?.storageUsedBytes).toBe(5_242_880);
    client.service.invalidateUsage(); // after an upload or a removal
    expect((await client.service.getStatus()).usage?.storageUsedBytes).toBe(9_000_000);
    expect(server.accountReads).toBe(2);

    clock.advance(31_000);
    server.usage = { storageUsedBytes: 1, storageQuotaBytes: 104_857_600 };
    expect((await client.service.getStatus()).usage?.storageUsedBytes).toBe(1);
  });

  it('the status carries no token, and the schema accepts usage, null and absence', async () => {
    const server = new FakeServer();
    const client = createClient(server);
    client.bind();
    await client.service.signIn();
    const status = await client.service.getStatus();
    expect(JSON.stringify(status)).not.toMatch(/token|crt_|Bearer/i);
    expect(accountStatusSchema.safeParse(status).success).toBe(true);
    const base = { enabled: true, signedIn: true, sync: IDLE };
    expect(accountStatusSchema.safeParse({ ...base, usage: null }).success).toBe(true);
    expect(accountStatusSchema.safeParse(base).success).toBe(true);
    expect(
      accountStatusSchema.safeParse({
        ...base,
        usage: { storageUsedBytes: -1, storageQuotaBytes: 1 },
      }).success,
    ).toBe(false);
    expect(
      accountStatusSchema.safeParse({
        ...base,
        usage: { storageUsedBytes: 1, storageQuotaBytes: 1, extra: 1 },
      }).success,
    ).toBe(false);
  });

  it('when the server cannot be asked the usage is null (the library hides the bar)', async () => {
    const server = new FakeServer();
    const client = createClient(server);
    client.bind();
    await client.service.signIn();
    server.failures.push({
      match: '/v1/account',
      response: () => new Response('{}', { status: 503 }),
      times: 5,
    });
    const status = await client.service.getStatus();
    expect(status.signedIn).toBe(true);
    expect(status.usage).toBeNull();
  });
});
