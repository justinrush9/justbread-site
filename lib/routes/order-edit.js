/**
 * POST /api/order-edit  (admin only). SPEC.md 6a and 6c.
 *   { action: 'create_manual', fields }
 *   { action: 'edit', id, fields }        move / loaves / address / phone / note
 *   { action: 'cancel', id }              take one delivery off the sheet (no refund)
 *   { action: 'resolve_declined', id }
 * Never writes to Stripe.
 */

const { isAdminRequest } = require('../adminAuth');
const edits = require('../orderEdits');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!isAdminRequest(req)) return res.status(401).json({ error: 'Unauthorized' });
  const { action, id, fields } = req.body || {};
  try {
    const actions = {
      create_manual: () => edits.createManual(fields || {}),
      edit: () => edits.editOrder(id, fields || {}),
      cancel: () => edits.cancelDelivery(id),
      resolve_declined: () => edits.resolveDeclined(id),
    };
    if (!actions[action]) return res.status(400).json({ error: 'unknown action' });
    return res.status(200).json(await actions[action]());
  } catch (err) {
    if (err instanceof edits.OrderEditError) return res.status(400).json({ error: err.message });
    console.error('order-edit failed:', err.message);
    return res.status(500).json({ error: 'Internal error' });
  }
};
