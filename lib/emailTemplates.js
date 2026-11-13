/**
 * Email wording (SPEC.md 9d). DRAFTS until Jay approves them: customer emails
 * stay held (lib/email.js) until he switches them on.
 * Style: Jay's voice, short, no em dashes. Signed "Justin" (his name to customers).
 */

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const first = (name) => (String(name || '').trim().split(/\s+/)[0] || 'there');
const loaves = (n) => `${n} ${n === 1 ? 'loaf' : 'loaves'}`;
const day = (d) => new Date(`${String(d).slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' });
// Pickup labels come from the delivery code (lib/deliveryCodes.js), e.g. ECB ->
// "Energy City Brewing — Batavia". Emails say "Energy City Brewing in Batavia":
// no em dash, and no internal notes like "(via Sharon)".
const place = (label) => String(label || '').replace(/\s*\([^)]*\)/g, '').replace(/\s*—\s*/g, ' in ').trim();
// "loaf" for one, "2 loaves" for more: reads as "your loaf" / "your 2 loaves".
const bread = (n) => (n === 1 ? 'loaf' : loaves(n));
// UPS Ground arrival: the next business day after shipping, skipping weekends
// and the UPS holidays that can fall on a bake week.
function upsArrival(shipDate) {
  const { shiftDate } = require('./dates');
  const holiday = (d) => {
    const t = new Date(`${d}T12:00:00Z`); const m = t.getUTCMonth() + 1; const dd = t.getUTCDate(); const w = t.getUTCDay();
    return (m === 11 && w === 4 && dd >= 22 && dd <= 28) || (m === 12 && dd === 25) || (m === 1 && dd === 1);
  };
  let d = shiftDate(String(shipDate).slice(0, 10), 1);
  while ([0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay()) || holiday(d)) d = shiftDate(d, 1);
  return d;
}

const cadenceWords = { weekly: 'every week', biweekly: 'every other week', monthly: 'once a month' };

function wrap(paragraphs, footer) {
  const text = [...paragraphs, '', 'Justin', 'JustBread', ...(footer ? ['', footer.text] : [])].join('\n\n').replace(/\n{3,}/g, '\n\n');
  const html = `<div style="font-family:Arial,sans-serif;font-size:16px;line-height:1.5;color:#111;max-width:520px">
${paragraphs.map((p) => `<p>${esc(p)}</p>`).join('\n')}
<p>Justin<br>JustBread</p>
${footer ? `<p style="font-size:13px;color:#777;margin-top:28px">${footer.html}</p>` : ''}
</div>`;
  return { text, html };
}

// "Your first loaf will be delivered to your door on Thursday, November 12."
function arrival(o, what) {
  const d = day(o.fulfillment_date);
  if (o.delivery_method === 'pickup') return `${what} will be waiting for you at ${place(o.pickup_location)} on ${d}.`;
  if (o.delivery_method === 'shipped') {
    const them = o.loaves === 1 ? 'it' : 'they';
    return `${what} will be baked on ${d}, then packaged and shipped as soon as ${them} ${o.loaves === 1 ? 'has' : 'have'} cooled. We use UPS Ground to get ${o.loaves === 1 ? 'it' : 'them'} to you as fast as possible, and most customers receive their bread within 24 hours, so look for ${o.loaves === 1 ? 'it' : 'them'} on ${day(upsArrival(o.fulfillment_date))}.`;
  }
  return `${what} will be delivered to your door on ${d}.`;
}

/** New order or new subscription's first payment. */
function confirmation(o) {
  const sub = o.order_type === 'subscription';
  const lines = [`Hi ${first(o.customer_name)},`];
  if (sub) {
    lines.push(`Welcome to JustBread, and thank you so much for subscribing! ${arrival(o, `Your first ${bread(o.loaves)}`)}`);
  } else {
    lines.push(`Thank you so much for your order! ${arrival(o, `Your ${bread(o.loaves)}`)}`);
  }
  if (sub) {
    lines.push(o.cadence === 'monthly'
      ? `You're set up for bread ${cadenceWords.monthly}. Your card is charged on the same date each month, and that week's delivery is yours.`
      : `You're set up for bread ${cadenceWords[o.cadence] || 'on a regular schedule'}. After this one, your card is charged Monday mornings for that week's delivery.`);
    lines.push("Need to skip a week or pause? Just reply to this email and I'll take care of it. You can update your card or cancel anytime at justbread.shop/manage.");
  }
  lines.push(`I want to make sure you love your bread. If you have any questions or concerns, or just want to talk bread, reply to this email. It comes straight to me.`);
  return { subject: sub ? 'Your New JustBread Subscription' : `Your JustBread order: ${day(o.fulfillment_date)}`, ...wrap(lines) };
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
      pickup ? `Your ${bread(o.loaves)} just got dropped off at ${place(o.pickup_location)}. Enjoy!` : `Your ${bread(o.loaves)} just got dropped off at your door. Enjoy!`,
    ], optOutFooter(link)),
  };
}

/** Jay ticked the UPS stop. */
function shipped(o, link) {
  return {
    subject: 'Your bread shipped',
    ...wrap([
      `Hi ${first(o.customer_name)},`,
      `Your ${bread(o.loaves)} went out today by UPS Ground and should arrive ${day(upsArrival(o.ship_date || require('./dates').todayCentral()))}.`,
    ], optOutFooter(link)),
  };
}

/** Subscription changes (6d, 9c) and single-delivery changes (6c). */
function change(kind, c) {
  const hi = `Hi ${first(c.name)},`;
  const COMMITTED = "We're committed to quality, customer satisfaction and continuous improvement. If you had an issue, please let me know! Just reply to this email, it comes straight to me.";
  const end = 'If you ever need anything or just want to talk bread, reply to this email. It comes straight to me.';
  switch (kind) {
    case 'skipped':
    {
      // Weekly / every-other-week renewals charge 6 AM Monday of the delivery
      // week (SPEC 4a); monthly keeps its own date, so only promise "not before".
      // Open-ended: customers can't unpause themselves (classic-mode subs have
      // no pause button in the portal), so they ask Jay.
      if (!c.until) return { subject: 'Your JustBread subscription is paused', ...wrap([hi, "Your subscription is paused, and you won't receive any charges while it's paused.", "Whenever you're ready for bread again, just reply to this email and I'll get you started right back up."]) };
      const { shiftDate } = require('./dates');
      const dow = new Date(`${String(c.until).slice(0, 10)}T12:00:00Z`).getUTCDay();
      const monday = shiftDate(String(c.until).slice(0, 10), -((dow + 6) % 7));
      const mondayWords = day(monday).replace(/^Monday, /, '');
      const charge = ['weekly', 'biweekly'].includes(c.cadence) ? ` Your card will be charged for that delivery on Monday morning, ${mondayWords}.` : '';
      return { subject: 'Your JustBread delivery is skipped', ...wrap([hi, `Got it, you're skipped until ${day(c.until)}. No bread and no charges before then.${charge}`, end]) };
    }
    case 'resumed':
      return { subject: 'Your JustBread subscription is reactivated', ...wrap([hi, `Welcome back! Your subscription has been reactivated.${c.next ? ` Your next delivery is ${day(c.next)}.` : ''}`, end]) };
    case 'cancellation_scheduled':
      return { subject: 'Your JustBread subscription is ending', ...wrap([hi, `Your subscription is set to end${c.last ? ` after your delivery on ${day(c.last)}` : ''}. Sorry to see you go, and thanks for supporting the bakery.`, COMMITTED, 'Changed your mind? You can undo it at justbread.shop/manage.']) };
    case 'cancellation_undone':
      return { subject: 'Your JustBread subscription is back on', ...wrap([hi, `Good news, your subscription is back on and will keep going as usual.${c.next ? ` Your next delivery is ${day(c.next)}.` : ''}`, end]) };
    case 'ended':
      return { subject: 'Your JustBread subscription has ended', ...wrap(c.failedPayment
        ? [hi, "Your subscription was cancelled because we weren't able to charge the card on file for your latest delivery. The payment was tried several times over five days, and each attempt was declined.", "If you'd like to keep getting bread, reply to this email and I'll help you get set back up with a different card, or sign up again anytime at justbread.shop."]
        : [hi, 'Your subscription has ended. Thank you so much for all the support. You can sign up again anytime at justbread.shop.', COMMITTED]) };
    case 'moved':
      return { subject: 'Your JustBread delivery moved', ...wrap([hi, `Your ${bread(c.loaves)} moved from ${day(c.from)} to ${day(c.to)}.`, end]) };
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

// Sample data for the preview screen. [Name] shows where the customer's
// first name goes; real emails use their own name.
const SAMPLE = {
  local: { customer_name: '[Name]', loaves: 1, delivery_method: 'local_delivery', fulfillment_date: '2026-11-12', order_type: 'subscription', cadence: 'weekly' },
  pickup: { customer_name: '[Name]', loaves: 2, delivery_method: 'pickup', pickup_location: 'Energy City Brewing — Batavia', fulfillment_date: '2026-11-12', order_type: 'onetime' },
  shipped: { customer_name: '[Name]', loaves: 2, delivery_method: 'shipped', fulfillment_date: '2026-11-12', order_type: 'onetime' },
  monthly: { customer_name: '[Name]', loaves: 1, delivery_method: 'local_delivery', fulfillment_date: '2026-11-12', order_type: 'subscription', cadence: 'monthly' },
};

function previews(link = 'https://www.justbread.shop/api/email-prefs?e=...') {
  return [
    ['New subscription (weekly)', confirmation(SAMPLE.local)],
    ['New subscription (monthly)', confirmation(SAMPLE.monthly)],
    ['Order confirmation (one-time pickup)', confirmation(SAMPLE.pickup)],
    ['Order confirmation (one-time shipped)', confirmation(SAMPLE.shipped)],
    ['Delivered (door)', delivered(SAMPLE.local, link)],
    ['Delivered (pickup point)', delivered(SAMPLE.pickup, link)],
    ['Shipped', shipped(SAMPLE.shipped, link)],
    ['Skipped until a date (weekly or every other week)', change('skipped', { name: '[Name]', until: '2026-12-03', cadence: 'weekly' })],
    ['Skipped until a date (monthly)', change('skipped', { name: '[Name]', until: '2026-12-03', cadence: 'monthly' })],
    ['Paused (no end date, set by you)', change('skipped', { name: '[Name]' })],
    ['Resumed', change('resumed', { name: '[Name]', next: '2026-11-19' })],
    ['Cancellation scheduled', change('cancellation_scheduled', { name: '[Name]', last: '2026-11-26' })],
    ['Cancellation undone', change('cancellation_undone', { name: '[Name]', next: '2026-11-19' })],
    ['Subscription ended (customer cancelled)', change('ended', { name: '[Name]' })],
    ['Subscription ended (failed payments)', change('ended', { name: '[Name]', failedPayment: true })],
    ['One delivery moved', change('moved', { name: '[Name]', loaves: 1, from: '2026-11-12', to: '2026-11-19' })],
    ['One delivery cancelled', change('cancelled', { name: '[Name]', date: '2026-11-12' })],
    ['Notice to all subscribers (example)', broadcast('Thanksgiving delivery', 'Thanksgiving week, bread goes out Wednesday, November 25 instead of Thursday.\n\nEverything goes back to normal on Thursday, December 3.', '[Name]')],
  ].map(([name, e]) => ({ name, ...e }));
}

module.exports = { confirmation, delivered, shipped, change, broadcast, alert, previews };
