import { FastifyInstance } from 'fastify';
import { AppDeps } from '../app.js';
import { checkAdmin } from '../auth.js';
import { DynamicConfigSchema } from '../../shared/config/dynamic.js';

export function registerConfigRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get('/v1/config', async () => {
    const { version, config } = await deps.configService.get();
    return { version, config };
  });

  app.put('/v1/config', async (req, reply) => {
    if (!checkAdmin(deps.env.ADMIN_KEY, req.headers as any)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const body = req.body as { expectedVersion?: number; config?: unknown };
    if (typeof body?.expectedVersion !== 'number') {
      return reply.code(400).send({ error: 'expectedVersion (number) required' });
    }
    const parsed = DynamicConfigSchema.safeParse(body.config);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid config', issues: parsed.error.issues });
    }
    const newVersion = await deps.configService.update(parsed.data, body.expectedVersion);
    if (newVersion === null) {
      return reply.code(409).send({ error: 'stale version' });
    }
    return { version: newVersion };
  });
}
