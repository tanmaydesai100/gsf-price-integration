/**
 * Mirrors laravel/snippets/routes-api.php + GsfPriceController.php.
 *
 * Mount it into your Express app. Keep it behind authentication: it returns
 * trade cost.
 *
 *   import gsfRouter from './snippets/route-express.js';
 *   app.use('/api/gsf', requireAuth, rateLimit({ windowMs: 60_000, max: 30 }), gsfRouter);
 *
 * Never call GSF from the browser directly: CORS blocks it, and it would leak
 * the session cookie and our buying prices to anyone who opens DevTools.
 */

import express from 'express';

import { GsfAuthError, GsfBlockedError, GsfError } from '../src/errors.js';
import { GsfPriceService } from '../src/priceService.js';

const router = express.Router();
const prices = new GsfPriceService();

/**
 * POST /api/gsf/part-price
 * { "registration": "P44PYN", "category": "Wipers", "brand": "BOSCH" }
 */
router.post('/part-price', express.json(), async (req, res) => {
  const { registration, category, brand, fitment, prefer } = req.body ?? {};

  const errors = [];
  if (!registration || typeof registration !== 'string' || registration.length > 12) {
    errors.push('registration is required (max 12 chars)');
  }
  if (!category || typeof category !== 'string' || category.length > 60) {
    errors.push('category is required (max 60 chars)');
  }
  if (brand && (typeof brand !== 'string' || brand.length > 40)) {
    errors.push('brand must be a string (max 40 chars)');
  }
  if (fitment && !['Front', 'Rear'].includes(fitment)) {
    errors.push('fitment must be Front or Rear');
  }
  if (prefer && !['availability', 'price'].includes(prefer)) {
    errors.push('prefer must be availability or price');
  }
  if (errors.length) {
    return res.status(422).json({ error: 'validation_failed', messages: errors });
  }

  try {
    const result = await prices.getPartPrice(
      registration,
      category,
      brand ?? null,
      fitment ?? 'Front',
      prefer ?? null,
    );

    return res.status(result.found ? 200 : 404).json(result);
  } catch (error) {
    if (error instanceof GsfBlockedError) {
      // Edge block. Do not let the caller hammer us into a harder block.
      return res.status(503).json({
        error: 'supplier_blocked',
        message: 'GSF is refusing automated requests from this server right now.',
      });
    }
    if (error instanceof GsfAuthError) {
      return res.status(503).json({
        error: 'supplier_auth',
        message: 'Could not sign in to GSF. Credentials or session need attention.',
      });
    }
    if (error instanceof GsfError) {
      return res.status(502).json({ error: 'supplier_error', message: error.message });
    }
    throw error;
  }
});

export default router;
