import { BadGatewayException, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ClientHeaderGuard } from '../../common/client-header';
import { AppConfigService } from '../config/config.service';
import { DatabaseService } from '../database/database.service';
import { EmailAccountsService } from '../email-accounts/email-accounts.service';
import { MailboxActionsController } from './mailbox-actions.controller';
import { MailboxActionsService } from './mailbox-actions.service';
import { MailboxReconcileService } from './mailbox-reconcile.service';
import { MailboxWriterService } from './mailbox-writer.service';

function makeApp(writesEnabled: boolean) {
  const rows: Record<string, Record<string, unknown>> = {
    ok: { id: 'ok', action: 'move_to_trash', status: 'succeeded', accountId: 'acc1', sourceMailbox: 'INBOX', destMailbox: 'Trash' },
    failed: { id: 'failed', action: 'move_to_trash', status: 'failed', accountId: 'acc1', sourceMailbox: 'INBOX', destMailbox: 'Trash' },
    undone: { id: 'undone', action: 'move_to_trash', status: 'undone', accountId: 'acc1', sourceMailbox: 'INBOX', destMailbox: 'Trash' },
  };
  const db = {
    mailboxAction: {
      findMany: jest.fn(async (args: { include?: unknown }) =>
        args.include ? [{ id: 'ok', account: { label: 'A' } }] : [],
      ),
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => rows[where.id] ?? null),
    },
    emailAccount: { findUnique: jest.fn() },
  };
  const config = { mailboxWritesEnabled: writesEnabled };
  const factory = jest.fn(() => {
    throw new Error('no IMAP in controller tests');
  });
  const credentials = { getImapCredentials: jest.fn() };
  const writer = new MailboxWriterService(
    db as unknown as DatabaseService,
    config as unknown as AppConfigService,
    credentials as unknown as EmailAccountsService,
    factory as unknown as ConstructorParameters<typeof MailboxWriterService>[3],
  );
  const reconciler = new MailboxReconcileService(
    db as unknown as DatabaseService,
    config as unknown as AppConfigService,
    credentials as unknown as EmailAccountsService,
    factory as unknown as ConstructorParameters<typeof MailboxReconcileService>[3],
  );
  const service = new MailboxActionsService(
    db as unknown as DatabaseService,
    config as unknown as AppConfigService,
    writer,
    reconciler,
  );
  return { db, writer, reconciler, service, factory, credentials };
}

describe('MailboxActionsController', () => {
  let app: INestApplication;
  let fx: ReturnType<typeof makeApp>;

  async function boot(writesEnabled: boolean) {
    fx = makeApp(writesEnabled);
    const moduleRef = await Test.createTestingModule({
      controllers: [MailboxActionsController],
      providers: [{ provide: MailboxActionsService, useValue: fx.service }],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalGuards(new ClientHeaderGuard());
    await app.init();
  }

  afterEach(async () => {
    await app?.close();
  });

  /** A write-capable POST from a local client (sends the header). */
  const post = (path: string) =>
    request(app.getHttpServer()).post(path).set('X-Email-AI-Client', 'test');

  describe('GET /mailbox-actions/status', () => {
    it.each([true, false])('reports writesEnabled=%p without IMAP or DB', async (enabled) => {
      await boot(enabled);
      const res = await request(app.getHttpServer()).get('/mailbox-actions/status').expect(200);
      expect(res.body).toEqual({ writesEnabled: enabled });
      expect(fx.factory).not.toHaveBeenCalled();
      expect(fx.db.mailboxAction.findMany).not.toHaveBeenCalled();
    });
  });

  describe('GET /mailbox-actions', () => {
    it('defaults to the 50 newest', async () => {
      await boot(false);
      await request(app.getHttpServer()).get('/mailbox-actions').expect(200);
      expect(fx.db.mailboxAction.findMany).toHaveBeenCalledWith({
        where: {},
        include: { account: { select: { label: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 50,
      });
    });

    it('filters by accountId and status', async () => {
      await boot(false);
      await request(app.getHttpServer())
        .get('/mailbox-actions?limit=5&accountId=acc1&status=succeeded')
        .expect(200);
      expect(fx.db.mailboxAction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { accountId: 'acc1', status: 'succeeded' }, take: 5 }),
      );
    });

    it.each(['status=bogus', 'limit=0', 'limit=501', 'limit=abc'])('400 for %s', async (qs) => {
      await boot(false);
      await request(app.getHttpServer()).get(`/mailbox-actions?${qs}`).expect(400);
      expect(fx.db.mailboxAction.findMany).not.toHaveBeenCalled();
    });
  });

  describe('X-Email-AI-Client header', () => {
    it.each(['/mailbox-actions/ok/undo', '/mailbox-actions/reconcile'])(
      '403 for %s without the header, before any lookup',
      async (path) => {
        await boot(true);
        const res = await request(app.getHttpServer()).post(path).expect(403);
        expect(res.body.message).toMatch(/X-Email-AI-Client/);
        expect(fx.db.mailboxAction.findUnique).not.toHaveBeenCalled();
        expect(fx.db.mailboxAction.findMany).not.toHaveBeenCalled();
        expect(fx.factory).not.toHaveBeenCalled();
      },
    );

    it('GET endpoints need no header', async () => {
      await boot(true);
      await request(app.getHttpServer()).get('/mailbox-actions').expect(200);
      await request(app.getHttpServer()).get('/mailbox-actions/status').expect(200);
    });
  });

  describe('POST /mailbox-actions/reconcile', () => {
    it('403 when writes are disabled', async () => {
      await boot(false);
      await post('/mailbox-actions/reconcile').expect(403);
      expect(fx.db.mailboxAction.findMany).not.toHaveBeenCalled();
    });

    it('200 with the reconcile summary', async () => {
      await boot(true);
      const res = await post('/mailbox-actions/reconcile?accountId=acc1').expect(200);
      expect(res.body).toEqual({ examined: 0, resolved: 0, unresolved: 0, accounts: [] });
      expect(fx.db.mailboxAction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ accountId: 'acc1' }) }),
      );
    });
  });

  describe('POST /mailbox-actions/:id/undo', () => {
    it('403 when writes are disabled, before any lookup', async () => {
      await boot(false);
      await post('/mailbox-actions/ok/undo').expect(403);
      expect(fx.db.mailboxAction.findUnique).not.toHaveBeenCalled();
      expect(fx.factory).not.toHaveBeenCalled();
    });

    it('404 for an unknown id', async () => {
      await boot(true);
      await post('/mailbox-actions/nope/undo').expect(404);
    });

    it.each(['failed', 'undone'])('409 for a %s action', async (id) => {
      await boot(true);
      await post(`/mailbox-actions/${id}/undo`).expect(409);
      expect(fx.factory).not.toHaveBeenCalled();
    });

    it('502 when the message is not in Trash', async () => {
      await boot(true);
      jest.spyOn(fx.writer, 'restore').mockRejectedValue(new BadGatewayException('not found in Trash'));
      await post('/mailbox-actions/ok/undo').expect(502);
    });

    it('200 with {original, restore}', async () => {
      await boot(true);
      jest.spyOn(fx.writer, 'restore').mockResolvedValue({
        original: { id: 'ok', status: 'undone' },
        restore: { id: 'r1', undoOfId: 'ok' },
      } as never);
      const res = await post('/mailbox-actions/ok/undo').expect(200);
      expect(res.body).toEqual({
        original: { id: 'ok', status: 'undone' },
        restore: { id: 'r1', undoOfId: 'ok' },
      });
    });
  });
});
