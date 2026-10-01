'use strict';
// Presentation primitives only. Permissions and accounting remain server-controlled.
window.AjoUI = (() => {
  const escape = (value) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  const money = (value) =>
    new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN' }).format(value || 0);
  const labels = {
    draft: 'Getting started',
    review: 'Needs review',
    active: 'Active',
    completed: 'Completed',
    archived: 'Archived',
    success: 'Confirmed',
    paid: 'Paid',
    unknown: 'Needs checking',
    initializing: 'Starting payment',
    pending: 'Pending',
    awaiting_confirmation: 'Awaiting receipt',
    disputed: 'Disputed',
    failed: 'Failed',
    confirmed: 'Confirmed',
    legacy: 'Historical',
    admin: 'Admin',
    next: 'This turn',
  };
  const badge = (status) =>
    `<span class="badge ${escape(status)}">${escape(labels[status] || String(status).replaceAll('_', ' '))}</span>`;
  const initials = (name) =>
    String(name || '?')
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((n) => n[0])
      .join('')
      .toUpperCase();
  const empty = (title, copy, compact = false) =>
    `<div class="empty ${compact ? 'compact' : ''}">${compact ? '' : '<span class="empty-symbol" aria-hidden="true">↳</span>'}<h2>${escape(title)}</h2><p>${escape(copy)}</p></div>`;
  function groupRow(g, index) {
    return `<button class="group-row" data-group="${escape(g.id)}"><span class="row-index" aria-hidden="true">${String(index + 1).padStart(2, '0')}</span><div><h2>${escape(g.name)}</h2>${badge(g.status)}<p>${g.memberCount} members · ${escape(g.frequency)}</p></div><div class="row-contribution"><span class="row-value">${money(g.contributionAmount)}</span><span class="row-label">Per member / ${escape(g.frequency === 'daily' ? 'day' : g.frequency === 'weekly' ? 'week' : 'month')}</span></div><div class="row-balance"><span class="row-value">${money(g.availableBalance)}</span><span class="row-label">Estimated ledger balance</span></div><span class="row-arrow" aria-hidden="true">↗</span></button>`;
  }
  function nextStep(g) {
    const own = g.obligations.find((o) => o.membershipId === g.currentUser.membershipId);
    const admin = g.currentUser.role === 'admin';
    const pending = g.contributions.some(
      (c) =>
        c.membershipId === g.currentUser.membershipId &&
        c.round === g.currentRound &&
        ['initializing', 'pending', 'unknown'].includes(c.status),
    );
    if (g.status === 'review')
      return {
        title: 'Let’s get the record in order.',
        copy: 'Payments are paused for review. Check the ledger and agree on the reconciled bank balance with your group.',
        target: 'ledger',
        label: 'Review the ledger',
      };
    if (g.status === 'archived')
      return {
        title: 'This circle’s record stays with you.',
        copy: 'The circle is closed to new activity. Your contributions and payout history are still available.',
        target: 'ledger',
        label: 'View the record',
      };
    if (g.status === 'completed')
      return {
        title: 'A full circle. Well done.',
        copy: admin
          ? 'Everyone has had their turn. Review the members and payout order before starting another cycle.'
          : 'This cycle is complete. Your administrator can prepare the next one with the group.',
        target: 'details',
        label: 'Review group details',
      };
    if (g.status === 'draft')
      return {
        title: admin ? 'Bring your circle together.' : 'You’re part of the circle.',
        copy: admin
          ? 'Invite your members, agree on a bank account and set the payout order. Then you can begin.'
          : 'Your administrator is getting the group ready. Check the proposed bank account and approve it when you agree.',
        target: 'details',
        label: admin ? 'Set up your circle' : 'View group details',
      };
    if (g.pendingPayout?.membershipId === g.currentUser.membershipId)
      return {
        title: 'Has your payout arrived?',
        copy: 'Check your bank account, then confirm receipt below. If the money has not arrived, report it so the group can resolve it.',
        target: 'payout',
        label: 'Check your payout',
      };
    if (pending)
      return {
        title: 'Your payment is being checked.',
        copy: 'A pending payment reserves part of your contribution. Check its status in the ledger before trying again.',
        target: 'ledger',
        label: 'Check payment status',
      };
    if (own?.due)
      return {
        title: `${money(own.due)} to complete your part.`,
        copy: 'Pay through Paystack into your group’s agreed bank account. Your confirmed contribution appears in the shared ledger.',
        pay: true,
      };
    if (g.allPaidThisRound)
      return {
        title: 'Everyone’s contribution is in.',
        copy: admin
          ? 'Check the settled bank balance, then record the completed transfer to this round’s recipient.'
          : 'The group is ready for its next payout. Your administrator records the transfer and the recipient confirms receipt.',
        target: 'payout',
        label: 'View this payout',
      };
    return {
      title: 'Your part is complete.',
      copy: 'Your contribution is confirmed. Follow the rest of the round below while your circle gets ready for its next turn.',
    };
  }
  function bankPanel(group) {
    const admin = group.currentUser.role === 'admin',
      editable = ['draft', 'completed'].includes(group.status);
    const bankInfo = group.bankAccountConfigured
      ? `<p>${escape(group.accountName)}<br><span class="small">${escape(group.bankName)} · ${escape(group.accountNumber)}</span></p>`
      : '<p class="muted">No agreed bank account yet.</p>';
    return `<h2>Group settlement account</h2>${bankInfo}<p class="small">All active members must approve an account proposal. Account details stay fixed during the cycle.</p>${admin && editable ? '<button class="secondary" data-action="bank">Propose bank account</button>' : ''}${group.bankChanges.map((p) => `<div class="bank-proposal"><strong>${escape(p.accountName)}</strong><p>${escape(p.bankName)} · ${escape(p.accountNumber)}</p><p>${p.approvals.length}/${group.members.length} member approvals</p><button class="quiet" data-action="approve-bank" data-id="${escape(p.id)}">Approve account / apply agreed change</button></div>`).join('')}`;
  }
  function payoutPanel(group) {
    const admin = group.currentUser.role === 'admin',
      editable = ['draft', 'completed'].includes(group.status);
    const payout = group.pendingPayout;
    return `<h2>Payout this round</h2>${payout ? `<p>${escape(group.payoutHistory.find((p) => p.id === payout.id)?.memberName)} · ${money(payout.amountKobo / 100)}</p>${badge(payout.status)}<p class="small">Transfer reference: ${escape(payout.transferReference)}</p>${payout.membershipId === group.currentUser.membershipId && ['awaiting_confirmation', 'disputed'].includes(payout.status) ? `<button class="primary" data-action="confirm-payout" data-id="${escape(payout.id)}">Confirm money received</button> <button class="quiet danger" data-action="dispute-payout" data-id="${escape(payout.id)}">I have not received it</button>` : ''}` : group.currentRecipient ? `<p>Next recipient: <strong>${escape(group.currentRecipient.name)}</strong></p><p>${money(group.contributionAmount * group.cycleSize)} · ${group.membersPaidThisRound.length}/${group.members.length} members fully paid</p>${admin ? '<button class="secondary" data-action="reconcile">Record settled bank balance</button><button class="primary full" data-action="payout">Record manual transfer</button>' : ''}` : '<p class="muted">Start a cycle to see the next recipient.</p>'}${admin && group.status === 'review' ? '<button class="secondary" data-action="reconcile">Record reviewed bank balance</button>' : ''}<p class="small">Ajo does not send this payout. Record your completed bank transfer, then the recipient confirms receipt.</p>`;
  }
  function membersPanel(group) {
    const admin = group.currentUser.role === 'admin',
      editable = ['draft', 'completed'].includes(group.status);
    return `<h2>Members & invitations</h2>${group.inviteCode && editable ? `<p class="small">Invite code: <strong class="invite-code">${escape(group.inviteCode)}</strong> <button class="quiet" data-action="copy">Copy</button></p>` : ''}${group.members.map((m) => `<div class="member-row"><span>${escape(m.name)} ${m.role === 'admin' ? badge('admin') : ''}</span>${admin && editable && m.role !== 'admin' ? `<span><button class="quiet" data-action="transfer-admin" data-id="${escape(m.membershipId)}">Make admin</button> · <button class="quiet danger" data-action="remove" data-id="${escape(m.membershipId)}">Remove</button></span>` : ''}</div>`).join('')}<p class="small">Removing a member keeps their financial history.</p>`;
  }
  const activityLabels = {
    'group.created': 'Circle created',
    'group.archived': 'Circle archived',
    'member.joined': 'A member joined',
    'member.deactivated': 'A member was removed',
    'administrator.transferred': 'Administrator changed',
    'order.changed': 'Payout order updated',
    'cycle.started': 'A new cycle started',
    'bank.proposed': 'Bank account proposed',
    'bank.approved': 'Bank account approved by a member',
    'bank.changed': 'Agreed bank account applied',
    'bank.reconciled': 'Bank balance recorded',
    'payment.intent_created': 'Payment started',
    'payment.confirmed': 'Contribution confirmed',
    'payment.reversed': 'Payment reversal reported',
    'payout.recorded': 'Manual transfer recorded',
    'payout.confirmed': 'Recipient confirmed their payout',
    'payout.disputed': 'Payout reported as not received',
    'review.approved': 'Financial review approved by a member',
    'review.completed': 'Financial review completed',
    'bank.apply_retry_required': 'Bank account update needs another attempt',
    'refund.processed': 'Refund processed',
    'charge.dispute.create': 'Payment dispute opened',
    'charge.dispute.resolve': 'Payment dispute updated',
  };
  function activity(a) {
    return activityLabels[a.action] || String(a.action).replaceAll('.', ' ').replaceAll('_', ' ');
  }
  function keyboardTabs(root) {
    root.addEventListener('keydown', (event) => {
      const buttons = [...root.querySelectorAll('[role="tab"]')];
      const index = buttons.indexOf(document.activeElement);
      if (index < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? buttons.length - 1
            : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next].focus();
      buttons[next].click();
    });
  }
  function selectTab(button, selected) {
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
  }
  return {
    escape,
    money,
    badge,
    initials,
    empty,
    groupRow,
    bankPanel,
    payoutPanel,
    membersPanel,
    nextStep,
    activity,
    keyboardTabs,
    selectTab,
  };
})();
