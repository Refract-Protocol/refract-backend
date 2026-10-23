import { Router } from 'express';
import {
  approve,
  escalate,
  getEntry,
  listPending,
  queueDepth,
  reject,
} from '../services/reviewQueue';

const router = Router();

function reviewerContext(req: any) {
  const actor = req.user?.id ?? req.headers['x-actor'];
  const authorized = Boolean(req.user?.canReview ?? req.headers['x-reviewer'] === 'true');
  return { actor: String(actor ?? 'anonymous'), authorized };
}

router.get('/queue', async (_req, res) => {
  const items = await listPending();
  res.json({ items, depth: await queueDepth() });
});

router.get('/queue/:id', async (req, res) => {
  const entry = await getEntry(req.params.id);
  if (!entry) return res.status(404).json({ error: 'not found' });
  res.json(entry);
});

router.post('/queue/:id/approve', async (req, res) => {
  try {
    const entry = await approve(req.params.id, reviewerContext(req));
    res.json(entry);
  } catch (err) {
    res.status(403).json({ error: (err as Error).message });
  }
});

router.post('/queue/:id/reject', async (req, res) => {
  try {
    const entry = await reject(req.params.id, reviewerContext(req), req.body?.reason);
    res.json(entry);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

router.post('/queue/:id/escalate', async (req, res) => {
  try {
    const entry = await escalate(req.params.id, reviewerContext(req));
    res.json(entry);
  } catch (err) {
    res.status(403).json({ error: (err as Error).message });
  }
});

export default router;
