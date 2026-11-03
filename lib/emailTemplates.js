/**
 * Email wording (SPEC.md 9d). DRAFTS until Jay approves them: customer emails
 * stay held (lib/email.js) until he switches them on.
 * Style: Jay's voice, short, no em dashes.
 */

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const first = (name) => (String(name || '').trim().split(/\s+/)[0] || 'there');
const loaves = (n) => `${n} ${n === 1 ? 'loaf' : 'loaves'}`;
const day = (d) => new Date(`${String(d).slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' });
// Pickup labels use an em dash ("Energy City Brewing — Batavia"); emails don't.
const place = (label) => String(label || '').replace(/\s*—\s*/g, ', ');
const cadenceWords = { weekly: 'every week', biweekly: 'every other week', monthly: 'once a month' };

function wrap(paragraphs, footer) {
  const text = [...paragraphs, '', 'Jay', 'JustBread', ...(footer ? ['', footer.text] : [])].join('\n\n').replace(/\n{3,}/g, '\n\n');
  const html = `<div style="font-family:Arial,sans-serif;font-size:16px;line-height:1.5;color:#111;max-width:520px">
${paragraphs.map((p) => `<p>${esc(p)}</p>`).join('\n')}
<p>Jay<br>JustBread</p>
${footer ? `<p style="font-size:13px;color:#777;margin-top:28px">${footer.html}</p>` : ''}
</div>`;
  return { text, html };
}

function where(o) {
  if (o.delivery_method === 'pickup') return `ready for pickup at ${place(o.pickup_location)}`;
  if (o.delivery_method === 'shipped') return 'shipped by UPS Ground, and should arrive Friday';
  return 'delivered to your door';
}

/** New order or new subscription's first payment. */
function confirmation(o) {
  const sub = o.order_type === 'subscription';
  const lines = [
    `Hi ${first(o.customer_name)},`,
    `Thanks for your order! Your ${loaves(o.loaves)} will be ${where(o)} on ${day(o.fulfillment_date)}.`,
  ];
  if (sub) {
    lines.push(o.cadence === 'monthly'
      ? `You're set up for bread ${cadenceWords.monthly}. Each month's charge goes through on the same date, and that week's Thursday is your delivery.`
      : `You're set up for bread ${cadenceWords[o.cadence] || 'on a regular schedule'}. After this one, your card is charged Monday mornings for that week's Thursday.`);
    lines.push('You can pause, skip or cancel anytime at justbread.shop/manage.');
  }
  lines.push('Questions? Just reply to this email.');
  return { subject: `Your JustBread order: ${day(o.fulfillment_date)}`, ...wrap(lines) };
}

function optOutFooter(link) {
  return { text: `Don't want these delivery notices? Turn them off: ${link}`, html: `Don't want these delivery notices? <a href="${esc(link)}" style="color:#777">Turn them off</a>.` };
}

/** Jay ticked Delivered on their stop. */
function delivered(o, link) {
  const pickup = o.delivery_method === 'pickup';
  return {
    subject: pickup ? `Your bread is at ${place(o.pickup_location)}` : 'Your bread is at your door',
    ...wrap([
      `Hi ${first(o.customer_name)},`,
      pickup ? `Your ${loaves(o.loaves)} just got dropped off at ${place(o.pickup_location)}. Enjoy!` : `Your ${loaves(o.loaves)} just got dropped off at your door. Enjoy!`,
    ], optOutFooter(link)),
  };
}

/** Jay ticked the UPS stop. */
function shipped(o, link) {
  return {
    subject: 'Your bread shipped',
    ...wrap([
      `Hi ${first(o.customer_name)},`,
      `Your ${loaves(o.loaves)} went out today by UPS Ground and should arrive tomorrow, Friday.`,
      'Sourdough keeps well on the counter for a few days. Slice and freeze anything you won\'t get to.',
    ], optOutFooter(link)),
  };
}

/** Subscription changes (6d, 9c) and single-delivery changes (6c). */
function change(kind, c) {
  const hi = `Hi ${first(c.name)},`;
  const end = 'Questions? Just reply to this email.';
  switch (kind) {
    case 'skipped':
      return { subject: 'Your JustBread delivery is skipped', ...wrap([hi, `Got it, no bread and no charge ${c.until ? `until ${day(c.until)}` : 'for now'}.${c.until ? ` Your next delivery is ${day(c.until)}.` : ''}`, end]) };
    case 'resumed':
      return { subject: 'Your JustBread subscription is back on', ...wrap([hi, `You're back on.${c.next ? ` Your next delivery is ${day(c.next)}.` : ''}`, end]) };
    case 'cancellation_scheduled':
      return { subject: 'Your JustBread subscription is ending', ...wrap([hi, `Your subscription is set to end${c.last ? ` after your delivery on ${day(c.last)}` : ''}. Sorry to see you go, and thanks for supporting the bakery.`, 'Changed your mind? You can undo it at justbread.shop/manage.', end]) };
    case 'cancellation_undone':
      return { subject: "You're staying with JustBread", ...wrap([hi, "Glad you're staying! Your subscription will keep going as usual.", end]) };
    case 'ended':
      return { subject: 'Your JustBread subscription has ended', ...wrap([hi, c.failedPayment
        ? "Your subscription ended because the last payments didn't go through. If you'd like to restart, you can sign up again anytime at justbread.shop."
        : 'Your subscription has ended. Thanks for all the support, and you can sign up again anytime at justbread.shop.', end]) };
    case 'moved':
      return { subject: 'Your JustBread delivery moved', ...wrap([hi, `Your ${loaves(c.loaves)} moved from ${day(c.from)} to ${day(c.to)}.`, end]) };
    case 'cancelled':
      return { subject: 'Your JustBread delivery is cancelled', ...wrap([hi, `Your delivery for ${day(c.date)} is cancelled.`, end]) };
    default:
      throw new Error(`unknown change ${kind}`);
  }
}

/** Notice to all subscribers, written by Jay. */
function broadcast(subject, body, name) {
  return { subject, ...wrap([`Hi ${first(name)},`, ...String(body).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)]) };
}

/** Jay's own alert. */
function alert(a) {
  const text = `${a.message}\n\nAll alerts: https://www.justbread.shop/admin/alerts/`;
  return { subject: `JustBread: ${a.message.split(':')[0]}`, text, html: `<p style="font-family:Arial,sans-serif;font-size:16px">${esc(a.message)}</p><p style="font-family:Arial,sans-serif;font-size:14px"><a href="https://www.justbread.shop/admin/alerts/">All alerts</a></p>` };
}

// Sample data for the preview screen.
const SAMPLE = {
  local: { customer_name: 'Linda Strong', loaves: 1, delivery_method: 'local_delivery', fulfillment_date: '2026-11-12', order_type: 'subscription', cadence: 'weekly' },
  pickup: { customer_name: 'Bert Berry', loaves: 2, delivery_method: 'pickup', pickup_location: 'Energy City Brewing — Batavia', fulfillment_date: '2026-11-12', order_type: 'onetime' },
  shipped: { customer_name: 'Allen Douglas', loaves: 2, delivery_method: 'shipped', fulfillment_date: '2026-11-12', order_type: 'onetime' },
  monthly: { customer_name: 'Judy Aldana', loaves: 1, delivery_method: 'local_delivery', fulfillment_date: '2026-11-12', order_type: 'subscription', cadence: 'monthly' },
};

function previews(link = 'https://www.justbread.shop/api/email-prefs?e=...') {
  return [
    ['Order confirmation (weekly subscriber)', confirmation(SAMPLE.local)],
    ['Order confirmation (monthly subscriber)', confirmation(SAMPLE.monthly)],
    ['Order confirmation (one-time pickup)', confirmation(SAMPLE.pickup)],
    ['Order confirmation (one-time shipped)', confirmation(SAMPLE.shipped)],
    ['Delivered (door)', delivered(SAMPLE.local, link)],
    ['Delivered (pickup point)', delivered(SAMPLE.pickup, link)],
    ['Shipped', shipped(SAMPLE.shipped, link)],
    ['Skipped until a date', change('skipped', { name: 'Linda Strong', until: '2026-12-03' })],
    ['Paused (no end date)', change('skipped', { name: 'Linda Strong' })],
    ['Resumed', change('resumed', { name: 'Linda Strong', next: '2026-11-19' })],
    ['Cancellation scheduled', change('cancellation_scheduled', { name: 'Linda Strong', last: '2026-11-26' })],
    ['Cancellation undone', change('cancellation_undone', { name: 'Linda Strong' })],
    ['Subscription ended (customer cancelled)', change('ended', { name: 'Linda Strong' })],
    ['Subscription ended (failed payments)', change('ended', { name: 'Linda Strong', failedPayment: true })],
    ['One delivery moved', change('moved', { name: 'Linda Strong', loaves: 1, from: '2026-11-12', to: '2026-11-19' })],
    ['One delivery cancelled', change('cancelled', { name: 'Linda Strong', date: '2026-11-12' })],
    ['Notice to all subscribers (example)', broadcast('No bread on Thanksgiving week', 'The bakery is closed the week of Thanksgiving, so there is no delivery on Thursday, November 26 and you will not be charged that week.\n\nEverything goes back to normal on Thursday, December 3.', 'Linda Strong')],
  ].map(([name, e]) => ({ name, ...e }));
}

module.exports = { confirmation, delivered, shipped, change, broadcast, alert, previews };
