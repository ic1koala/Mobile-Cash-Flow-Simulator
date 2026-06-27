// =====================================================================
//  CashFlow App – Core Logic
//  Offline-first, localStorage-backed cash-flow simulator.
// =====================================================================

'use strict';

// --- Constants & Config --------------------------------------------------
const STORAGE_KEYS = Object.freeze({
  ACCOUNTS:     'cf_accounts',
  EVENTS:       'cf_events',
  SIMULATIONS:  'cf_simulations',
  HIDE_BALANCE: 'cf_hide_balance',
  CHART_COLLAPSED: 'cf_chart_collapsed'
});

const TYPE_PRIORITY = Object.freeze({
  income:        1,
  reimbursement: 2,
  transfer:      3,
  expense:       4,
  credit_bill:   5
});

// --- Date Utilities ------------------------------------------------------

/** Format a Date to 'YYYY-MM-DD' using local timezone (avoids UTC shift) */
function formatDateLocal(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Add `days` to a YYYY-MM-DD string, return YYYY-MM-DD */
function addDays(dateStr, days) {
  const parts = dateStr.split('-');
  const date = new Date(+parts[0], +parts[1] - 1, +parts[2]);
  date.setDate(date.getDate() + days);
  return formatDateLocal(date);
}

/** Format a date string to Japanese display (e.g. 6/10(火)) */
function formatDateJP(dateStr, isToday = false) {
  if (isToday) return '今日';
  const DAYS = ['日', '月', '火', '水', '木', '金', '土'];
  const parts = dateStr.split('-');
  const d = new Date(+parts[0], +parts[1] - 1, +parts[2]);
  return `${d.getMonth() + 1}/${d.getDate()}(${DAYS[d.getDay()]})`;
}

// --- Application State ---------------------------------------------------

let state = {
  accounts:    [],  // { id, name, type, balance, linkedAccountId, billingDay }
  events:      [],  // { id, name, type, amount, accountId, date, isRecurring, recurrence, ... }
  simulations: [],  // { id, date, amount, fromAccountId, toAccountId, isRecurring, recurrence }
  hideBalance: false,
  chartCollapsed: false
};

// --- Currency Formatting (privacy-aware) ---------------------------------

function formatCurrency(val) {
  return state.hideBalance ? '¥••••••' : `¥${Number(val).toLocaleString()}`;
}

// --- Account Name Lookup -------------------------------------------------

function getAccountName(id) {
  const acc = state.accounts.find(a => a.id === id);
  return acc ? acc.name : '不明な口座';
}

// --- Seed Default Data (First Load) --------------------------------------

function seedDefaultData() {
  const today = new Date();
  const y = today.getFullYear();
  const m = String(today.getMonth() + 1).padStart(2, '0');

  state.accounts = [
    { id: 'acc-1', name: 'メガバンク口座', type: 'deposit', balance: 250000, linkedAccountId: '', billingDay: '' },
    { id: 'acc-2', name: 'サブネット銀行', type: 'deposit', balance: 80000,  linkedAccountId: '', billingDay: '' },
    { id: 'acc-3', name: '楽天カード',     type: 'credit',  balance: 0,      linkedAccountId: 'acc-1', billingDay: 27 },
    { id: 'acc-4', name: 'お財布現金',     type: 'cash',    balance: 15000,  linkedAccountId: '', billingDay: '' }
  ];

  state.events = [
    {
      id: 'evt-1', name: '給与 (毎月デポジット)', type: 'income',
      amount: 220000, accountId: 'acc-1',
      date: `${y}-${m}-25`, isRecurring: true, recurrence: 'monthly',
      reimbursementMonth: '', reimbursementDay: ''
    },
    {
      id: 'evt-2', name: 'マンション賃料', type: 'expense',
      amount: 78000, accountId: 'acc-1',
      date: `${y}-${m}-26`, isRecurring: true, recurrence: 'monthly',
      reimbursementMonth: '', reimbursementDay: ''
    },
    {
      id: 'evt-3', name: '楽天カード引き落とし', type: 'credit_bill',
      amount: 65000, accountId: 'acc-3',
      date: `${y}-${m}-27`, isRecurring: false, recurrence: 'none',
      reimbursementMonth: '', reimbursementDay: ''
    }
  ];

  let nm = today.getMonth() + 2; // next month (1-based)
  let ny = y;
  if (nm > 12) { nm = 1; ny++; }

  state.simulations = [
    {
      id: 'sim-1',
      date: `${ny}-${String(nm).padStart(2, '0')}-10`,
      amount: 30000,
      fromAccountId: 'acc-1', toAccountId: 'acc-4',
      isRecurring: false, recurrence: 'none'
    }
  ];

  saveState();
}

// --- Persistence ---------------------------------------------------------

function loadState() {
  const raw = localStorage.getItem(STORAGE_KEYS.ACCOUNTS);
  if (raw === null) {
    seedDefaultData();
  } else {
    state.accounts    = JSON.parse(raw || '[]');
    state.events      = JSON.parse(localStorage.getItem(STORAGE_KEYS.EVENTS) || '[]');
    state.simulations = JSON.parse(localStorage.getItem(STORAGE_KEYS.SIMULATIONS) || '[]');
    state.hideBalance = localStorage.getItem(STORAGE_KEYS.HIDE_BALANCE) === 'true';
    state.chartCollapsed = localStorage.getItem(STORAGE_KEYS.CHART_COLLAPSED) === 'true';
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEYS.ACCOUNTS,        JSON.stringify(state.accounts));
  localStorage.setItem(STORAGE_KEYS.EVENTS,           JSON.stringify(state.events));
  localStorage.setItem(STORAGE_KEYS.SIMULATIONS,      JSON.stringify(state.simulations));
  localStorage.setItem(STORAGE_KEYS.HIDE_BALANCE,     String(state.hideBalance));
  localStorage.setItem(STORAGE_KEYS.CHART_COLLAPSED,  String(state.chartCollapsed));
}

// --- Projection Engine ---------------------------------------------------

/**
 * Project monthly recurring occurrences of a dated item within [startDateStr, endDateStr].
 */
function projectMonthlyRecurring(item, startDateStr, endDateStr) {
  const instances = [];
  const start = new Date(startDateStr);
  const end   = new Date(endDateStr);
  const targetDay = new Date(item.date).getDate();

  let cy = start.getFullYear();
  let cm = start.getMonth();
  const ey = end.getFullYear();
  const em = end.getMonth();

  while (cy < ey || (cy === ey && cm <= em)) {
    const maxDays   = new Date(cy, cm + 1, 0).getDate();
    const day       = Math.min(targetDay, maxDays);
    const projected = formatDateLocal(new Date(cy, cm, day));

    if (projected >= startDateStr && projected <= endDateStr && projected >= item.date) {
      instances.push({ ...item, date: projected, isRecurringProjection: true });
    }

    cm++;
    if (cm > 11) { cm = 0; cy++; }
  }
  return instances;
}

/** Calculate total non-credit assets from a balance map */
function calculateTotalAssets(balances) {
  let total = 0;
  for (const acc of state.accounts) {
    if (acc.type !== 'credit') {
      total += (balances[acc.id] || 0);
    }
  }
  return total;
}

/**
 * Build the full chronological projection timeline.
 * Returns { groupedTimeline, dailyTimeline }.
 */
function generateTimelineData(daysToProject = 90) {
  const todayStr = formatDateLocal(new Date());
  const endStr   = addDays(todayStr, daysToProject);

  // 1. Initialise balances
  const runningBalances = {};
  for (const acc of state.accounts) {
    runningBalances[acc.id] = Number(acc.balance);
  }

  // 2. Gather events within range
  const rawEvents = [];

  for (const evt of state.events) {
    if (evt.isRecurring && evt.recurrence === 'monthly') {
      rawEvents.push(...projectMonthlyRecurring(evt, todayStr, endStr));
    } else if (evt.date >= todayStr && evt.date <= endStr) {
      rawEvents.push({ ...evt });
    }
  }

  for (const sim of state.simulations) {
    const simWithType = { ...sim, type: 'transfer' };
    if (sim.isRecurring && sim.recurrence === 'monthly') {
      rawEvents.push(...projectMonthlyRecurring(simWithType, todayStr, endStr));
    } else if (sim.date >= todayStr && sim.date <= endStr) {
      rawEvents.push(simWithType);
    }
  }

  // 3. Sort: date ascending → income first → expenses last
  rawEvents.sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return (TYPE_PRIORITY[a.type] || 99) - (TYPE_PRIORITY[b.type] || 99);
  });

  // 4. Walk through events, compute running balances
  const timelineDays = {};
  timelineDays[todayStr] = {
    date: todayStr,
    events: [],
    balances: { ...runningBalances },
    totalAssets: calculateTotalAssets(runningBalances),
    isToday: true
  };

  for (const evt of rawEvents) {
    const date = evt.date;
    if (!timelineDays[date]) {
      timelineDays[date] = {
        date, events: [], balances: {}, totalAssets: 0, isToday: false
      };
    }

    let warningMsg = '';
    let isInsufficient = false;

    // Apply financial impact
    switch (evt.type) {
      case 'income':
      case 'reimbursement':
        if (runningBalances[evt.accountId] !== undefined) {
          runningBalances[evt.accountId] += Number(evt.amount);
        }
        break;

      case 'expense':
        if (runningBalances[evt.accountId] !== undefined) {
          runningBalances[evt.accountId] -= Number(evt.amount);
          if (runningBalances[evt.accountId] < 0) {
            isInsufficient = true;
            warningMsg = `残高不足: ${formatCurrency(Math.abs(runningBalances[evt.accountId]))} 不足`;
          }
        }
        break;

      case 'credit_bill': {
        const cardAcc = state.accounts.find(a => a.id === evt.accountId);
        if (cardAcc?.linkedAccountId) {
          const linkId = cardAcc.linkedAccountId;
          if (runningBalances[linkId] !== undefined) {
            runningBalances[linkId] -= Number(evt.amount);
            if (runningBalances[linkId] < 0) {
              isInsufficient = true;
              warningMsg = `残高不足: ${formatCurrency(Math.abs(runningBalances[linkId]))} 不足`;
            }
          }
        } else if (runningBalances[evt.accountId] !== undefined) {
          runningBalances[evt.accountId] -= Number(evt.amount);
        }
        break;
      }

      case 'transfer': {
        const { fromAccountId, toAccountId, amount } = evt;
        if (runningBalances[fromAccountId] !== undefined) {
          runningBalances[fromAccountId] -= Number(amount);
          if (runningBalances[fromAccountId] < 0) {
            isInsufficient = true;
            warningMsg = `残高不足: ${formatCurrency(Math.abs(runningBalances[fromAccountId]))} 不足`;
          }
        }
        if (runningBalances[toAccountId] !== undefined) {
          runningBalances[toAccountId] += Number(amount);
        }
        break;
      }
    }

    timelineDays[date].events.push({
      id:   evt.id,
      name: evt.name,
      type: evt.type,
      amount: Number(evt.amount),
      accountId:     evt.accountId,
      fromAccountId: evt.fromAccountId,
      toAccountId:   evt.toAccountId,
      isInsufficient,
      warningMsg,
      balancesSnapshot:    { ...runningBalances },
      totalAssetsSnapshot: calculateTotalAssets(runningBalances)
    });

    timelineDays[date].balances    = { ...runningBalances };
    timelineDays[date].totalAssets = calculateTotalAssets(runningBalances);
  }

  // 5. Build continuous daily timeline for chart
  const dailyTimeline = [];
  let currentBal = { ...timelineDays[todayStr].balances };
  let runner = todayStr;

  while (runner <= endStr) {
    if (timelineDays[runner]) {
      currentBal = { ...timelineDays[runner].balances };
      dailyTimeline.push({ date: runner, ...timelineDays[runner] });
    } else {
      dailyTimeline.push({
        date: runner,
        events: [],
        balances: { ...currentBal },
        totalAssets: calculateTotalAssets(currentBal),
        isToday: false
      });
    }
    runner = addDays(runner, 1);
  }

  return {
    groupedTimeline: Object.values(timelineDays).sort((a, b) => a.date.localeCompare(b.date)),
    dailyTimeline
  };
}

// --- UI: Toast Notifications ---------------------------------------------

function showToast(message, isError = false) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.style.borderColor = isError ? 'var(--color-danger)' : 'var(--border-color)';
  toast.style.color       = isError ? 'var(--color-danger)' : 'var(--text-primary)';
  toast.classList.add('visible');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => toast.classList.remove('visible'), 3000);
}

// --- UI: SVG Trend Chart -------------------------------------------------

function renderTrendChart(dailyTimeline) {
  const svg = document.getElementById('trend-chart');
  // Clear using replaceChildren for safety
  while (svg.firstChild) svg.removeChild(svg.firstChild);

  if (dailyTimeline.length < 2) return;

  const W = 400, H = 160;
  const pL = 15, pR = 15, pT = 20, pB = 20;

  const values = dailyTimeline.map(d => d.totalAssets);
  const minV = Math.min(...values, 0);
  let maxV = Math.max(...values);
  if (maxV === minV) maxV = minV + 10000;
  const rangeY = maxV - minV;

  const pts = dailyTimeline.map((day, i) => ({
    x: pL + (i / (dailyTimeline.length - 1)) * (W - pL - pR),
    y: H - pB - ((day.totalAssets - minV) / rangeY) * (H - pT - pB),
    val: day.totalAssets
  }));

  // Helper to create SVG elements
  const svgEl = (tag, attrs = {}) => {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  };

  // Gradient definition
  const defs = svgEl('defs');
  defs.innerHTML = `
    <linearGradient id="chart-gradient" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"   stop-color="var(--color-primary)" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="var(--color-primary)" stop-opacity="0.00"/>
    </linearGradient>`;
  svg.appendChild(defs);

  // Grid lines (3 horizontal)
  for (let i = 0; i <= 3; i++) {
    const yCoord = H - pB - (i / 3) * (H - pT - pB);
    const yVal = minV + (i / 3) * rangeY;

    svg.appendChild(svgEl('line', {
      x1: pL, y1: yCoord, x2: W - pR, y2: yCoord, class: 'chart-grid-line'
    }));

    const label = svgEl('text', { x: pL, y: yCoord - 4, class: 'chart-axis-text' });
    label.textContent = state.hideBalance ? '¥•••k' : `¥${Math.floor(yVal / 1000).toLocaleString()}k`;
    svg.appendChild(label);
  }

  // Area fill
  const areaParts = [
    `M ${pts[0].x} ${H - pB}`,
    ...pts.map(p => `L ${p.x} ${p.y}`),
    `L ${pts[pts.length - 1].x} ${H - pB}`,
    'Z'
  ];
  svg.appendChild(svgEl('path', { d: areaParts.join(' '), class: 'chart-area' }));

  // Line
  const linePath = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
  svg.appendChild(svgEl('path', { d: linePath, class: 'chart-line' }));

  // Start & end marker dots
  [pts[0], pts[pts.length - 1]].forEach(p => {
    svg.appendChild(svgEl('circle', { cx: p.x, cy: p.y, r: '5', class: 'chart-point' }));
  });

  // Date labels
  const todayLabel = svgEl('text', { x: pL, y: H - 4, class: 'chart-axis-text' });
  todayLabel.textContent = '今日';
  svg.appendChild(todayLabel);

  const endLabel = svgEl('text', { x: W - pR - 35, y: H - 4, class: 'chart-axis-text' });
  endLabel.textContent = `${dailyTimeline.length}日後`;
  svg.appendChild(endLabel);
}

// --- UI: Timeline Renderer -----------------------------------------------

function renderTimeline(groupedTimeline) {
  const container = document.getElementById('timeline-list');
  container.innerHTML = '';

  // 1. Get list of target accounts that are not credit cards (deposit, cash, other)
  const targetAccounts = state.accounts.filter(acc => acc.type !== 'credit');

  if (targetAccounts.length === 0) {
    container.innerHTML = `
      <div class="glass-panel" style="text-align:center;padding:40px;color:var(--text-secondary);width:100%;">
        <p>登録された口座がありません。「口座・資産」タブから口座を追加してください。</p>
      </div>`;
    return;
  }

  const fragment = document.createDocumentFragment();

  // 2. Generate vertical timeline columns for each deposit/cash/other account
  for (const acc of targetAccounts) {
    const column = document.createElement('div');
    column.className = 'timeline-column';

    // Column Header (Account Name, Type Badge, Current Balance)
    const columnHeader = document.createElement('div');
    columnHeader.className = 'column-header';
    const typeLabels = { deposit: '預金', cash: '現金', other: 'その他' };
    const typeLabel = typeLabels[acc.type] || 'その他';
    columnHeader.innerHTML = `
      <div class="column-title">
        <span class="account-badge ${acc.type}">${typeLabel}</span>
        <strong>${escapeHtml(acc.name)}</strong>
      </div>
      <div class="column-balance">
        ${formatCurrency(acc.balance)}
      </div>
    `;
    column.appendChild(columnHeader);

    // Column Timeline events container
    const colTimeline = document.createElement('div');
    colTimeline.className = 'column-timeline';

    let hasColEvents = false;

    for (const day of groupedTimeline) {
      // Filter events affecting ONLY this specific account
      const colEvents = day.events.filter(evt => {
        // (A) Income / Expense / Reimbursement direct matching
        if (evt.accountId === acc.id && evt.type !== 'credit_bill') {
          return true;
        }
        // (B) Credit bills linked to this account
        if (evt.type === 'credit_bill') {
          const cardAcc = state.accounts.find(a => a.id === evt.accountId);
          if (cardAcc && cardAcc.linkedAccountId === acc.id) {
            return true;
          }
        }
        // (C) Transfers where this account is either from or to
        if (evt.type === 'transfer') {
          if (evt.fromAccountId === acc.id || evt.toAccountId === acc.id) {
            return true;
          }
        }
        return false;
      });

      // Always draw a date header if there are events, or if it is "Today"
      if (colEvents.length > 0 || day.isToday) {
        hasColEvents = true;

        const dateGroup = document.createElement('div');
        dateGroup.className = 'column-date-group';

        const dateHeader = document.createElement('div');
        dateHeader.className = `column-date-header ${day.isToday ? 'today' : ''}`;
        dateHeader.innerHTML = `
          <span class="column-date-dot"></span>
          <strong>${formatDateJP(day.date, day.isToday)}</strong>
        `;
        dateGroup.appendChild(dateHeader);

        // Render each filtered event card
        for (const evt of colEvents) {
          const card = document.createElement('div');
          
          // Determine warning class for negative balances on this account
          let isInsufficient = false;
          let warningMsg = '';

          if (evt.type === 'transfer' && evt.fromAccountId === acc.id) {
            isInsufficient = evt.isInsufficient;
            warningMsg = evt.warningMsg;
          } else if (evt.type === 'expense') {
            isInsufficient = evt.isInsufficient;
            warningMsg = evt.warningMsg;
          } else if (evt.type === 'credit_bill') {
            isInsufficient = evt.isInsufficient;
            warningMsg = evt.warningMsg;
          }

          card.className = `timeline-event-card${isInsufficient ? ' alert-card' : ''}`;
          card.setAttribute('role', 'button');
          card.setAttribute('tabindex', '0');

          let displayName = evt.name;
          let displayFlow = '';
          let displayAmount = evt.amount;
          let amountSign = '-';
          let typeClass = 'expense';
          let icon = '📉';

          if (evt.type === 'income') {
            icon = '💰';
            typeClass = 'income';
            amountSign = '+';
            displayFlow = `入金 ➔ ${escapeHtml(acc.name)}`;
          } else if (evt.type === 'reimbursement') {
            icon = '💼';
            typeClass = 'income';
            amountSign = '+';
            const targetMonthText = evt.reimbursementMonth ? ` [${evt.reimbursementMonth.replace('-', '年')}月分]` : '';
            displayName = `${evt.name}${targetMonthText}`;
            displayFlow = `経費立替回収 ➔ ${escapeHtml(acc.name)}`;
          } else if (evt.type === 'expense') {
            icon = '📉';
            typeClass = 'expense';
            amountSign = '-';
            displayFlow = `出金 ➔ ${escapeHtml(acc.name)}`;
          } else if (evt.type === 'credit_bill') {
            icon = '💳';
            typeClass = 'credit';
            amountSign = '-';
            const cardAcc = state.accounts.find(a => a.id === evt.accountId);
            const cardName = cardAcc ? cardAcc.name : 'クレジットカード';
            displayName = `${cardName}引き落とし`;
            displayFlow = `カード: ${escapeHtml(cardName)} ➔ 引落元: ${escapeHtml(acc.name)}`;
          } else if (evt.type === 'transfer') {
            icon = '🔄';
            typeClass = 'transfer';
            if (evt.fromAccountId === acc.id) {
              amountSign = '-';
              displayFlow = `資金移動 ➔ ${escapeHtml(getAccountName(evt.toAccountId))}`;
            } else {
              amountSign = '+';
              typeClass = 'income'; // Render positive on the receiving side
              displayFlow = `${escapeHtml(getAccountName(evt.fromAccountId))} ➔ 資金移動`;
            }
          }

          const warnClass = isInsufficient ? 'event-account-flow warning' : 'event-account-flow';
          const warnSuffix = isInsufficient ? ` (${warningMsg})` : '';
          const balSnapshot = evt.balancesSnapshot[acc.id] || 0;

          card.innerHTML = `
            <div class="event-card-left">
              <div class="event-icon-badge ${typeClass}">${icon}</div>
              <div class="event-info-wrapper">
                <span class="event-title">${escapeHtml(displayName)}</span>
                <span class="event-account-flow">${displayFlow}</span>
                <span class="${warnClass}">口座残高: ${formatCurrency(balSnapshot)}${warnSuffix}</span>
              </div>
            </div>
            <div class="event-card-right">
              <span class="event-amount ${typeClass}">${amountSign}${displayAmount.toLocaleString()}円</span>
            </div>
          `;

          // Handle click/keyboard to edit dialog
          const openHandler = () => {
            if (evt.type === 'transfer') openSimulationDialog(evt.id);
            else openEventDialog(evt.id);
          };
          card.addEventListener('click', openHandler);
          card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openHandler(); } });

          dateGroup.appendChild(card);
        }

        // Show the day's ending balance for this account
        const dayBal = day.balances[acc.id] || 0;
        const summary = document.createElement('div');
        summary.className = 'timeline-date-summary';
        summary.textContent = `残高: ${formatCurrency(dayBal)}`;
        dateGroup.appendChild(summary);

        colTimeline.appendChild(dateGroup);
      }
    }

    if (!hasColEvents) {
      colTimeline.innerHTML = `
        <div class="glass-panel" style="text-align:center;padding:24px 12px;color:var(--text-secondary);font-size:12px;">
          <p>表示期間内の予定はありません</p>
        </div>`;
    }

    column.appendChild(colTimeline);
    fragment.appendChild(column);
  }

  container.appendChild(fragment);
}

// --- UI: Accounts Screen -------------------------------------------------

function renderAccounts() {
  const container = document.getElementById('accounts-list');
  container.innerHTML = '';

  if (state.accounts.length === 0) {
    container.innerHTML = `
      <div class="glass-panel" style="text-align:center;padding:40px;color:var(--text-secondary);">
        <p>登録された口座がありません</p>
      </div>`;
    return;
  }

  const { dailyTimeline } = generateTimelineData(90);
  const endBalances = dailyTimeline[dailyTimeline.length - 1].balances;
  const fragment = document.createDocumentFragment();

  for (const acc of state.accounts) {
    const isAlert = acc.type !== 'credit' && endBalances[acc.id] < 0;
    const card = document.createElement('div');
    card.className = `account-card${isAlert ? ' alert-border' : ''}`;
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');

    const typeLabels = { deposit: '預金', credit: 'クレジット', cash: '現金', other: 'その他' };
    const typeLabel = typeLabels[acc.type] || 'その他';

    let linkHtml = '';
    if (acc.type === 'credit') {
      const billingText = acc.billingDay ? `毎月${acc.billingDay}日振替` : '引き落とし日未設定';
      const linkedName  = acc.linkedAccountId ? getAccountName(acc.linkedAccountId) : '引落口座未設定';
      linkHtml = `<div class="account-linked-desc">📅 ${billingText} | 🔗 ${linkedName}</div>`;
    }

    card.innerHTML = `
      <div class="account-card-top">
        <span class="account-badge ${acc.type}">${typeLabel}</span>
        <span class="account-edit-indicator">編集 ➔</span>
      </div>
      <div class="account-card-name">${escapeHtml(acc.name)}</div>
      <div class="account-card-balance" style="color:${isAlert ? 'var(--color-danger)' : 'inherit'}">
        ${formatCurrency(acc.balance)}
      </div>
      ${linkHtml}`;

    const handler = () => openAccountDialog(acc.id);
    card.addEventListener('click', handler);
    card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handler(); } });

    fragment.appendChild(card);
  }

  container.appendChild(fragment);
}



// --- UI: Reimbursements List ---------------------------------------------

function renderReimbursements() {
  const container = document.getElementById('reimbursements-list');
  if (!container) return;
  container.innerHTML = '';

  const list = state.events.filter(e => e.type === 'reimbursement');

  if (list.length === 0) {
    container.innerHTML = `
      <div class="glass-panel" style="text-align:center;padding:40px;color:var(--text-secondary);">
        <p style="font-size:24px;margin-bottom:8px;">💼</p>
        <p>登録された経費立替入金予定はありません</p>
      </div>`;
    return;
  }

  const fragment = document.createDocumentFragment();

  // Sort by date ascending
  list.sort((a, b) => a.date.localeCompare(b.date));

  for (const item of list) {
    const card = document.createElement('div');
    card.className = 'reimbursement-item-card';
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');

    const dateDisplay = formatDateJP(item.date);
    const targetMonthText = item.reimbursementMonth ? `${item.reimbursementMonth.replace('-', '年')}月分` : '';
    
    card.innerHTML = `
      <div class="reimbursement-item-left">
        <div class="event-icon-badge income">💼</div>
        <div class="reimbursement-item-details">
          <span class="reimbursement-item-title">${escapeHtml(item.name)}</span>
          <span class="reimbursement-item-meta">${targetMonthText} | 入金先: ${escapeHtml(getAccountName(item.accountId))}</span>
          <span class="reimbursement-item-meta" style="color:var(--text-muted);">予定日: ${item.date} (${dateDisplay})</span>
        </div>
      </div>
      <div class="reimbursement-item-right">
        <span class="reimbursement-item-amount">+${item.amount.toLocaleString()}円</span>
        <button class="btn-inline-delete" data-id="${item.id}" aria-label="予定を削除">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
          </svg>
        </button>
      </div>`;

    // Tap on card opens edit dialog
    card.addEventListener('click', (e) => {
      if (e.target.closest('.btn-inline-delete')) return;
      openEventDialog(item.id);
    });

    card.addEventListener('keydown', (e) => {
      if (e.target.closest('.btn-inline-delete')) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openEventDialog(item.id);
      }
    });

    // Delete button click handler
    const delBtn = card.querySelector('.btn-inline-delete');
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!confirm(`立替予定「${item.name}」を削除しますか？`)) return;
      state.events = state.events.filter(ev => ev.id !== item.id);
      saveState();
      setTimeout(() => {
        renderApp();
        showToast('立替予定を削除しました');
      }, 0);
    });

    fragment.appendChild(card);
  }

  container.appendChild(fragment);
}

// --- Master Render -------------------------------------------------------

function renderApp() {
  const daysToProject = parseInt(document.getElementById('timeline-range').value) || 90;
  const data = generateTimelineData(daysToProject);

  const startTotal     = data.dailyTimeline[0].totalAssets;
  const projectedTotal = data.dailyTimeline[data.dailyTimeline.length - 1].totalAssets;

  document.getElementById('total-assets-val').textContent = formatCurrency(startTotal);
  document.getElementById('projected-trend-lbl').textContent = state.hideBalance
    ? `${daysToProject}日後の予測: ¥••••••`
    : `${daysToProject}日後の予測: ¥${projectedTotal.toLocaleString()}`;

  // Trend indicator
  const trendEl = document.querySelector('.summary-trend');
  if (projectedTotal >= startTotal) {
    trendEl.style.color = 'var(--color-success)';
    trendEl.querySelector('.trend-icon').textContent = '📈';
  } else {
    trendEl.style.color = 'var(--color-danger)';
    trendEl.querySelector('.trend-icon').textContent = '📉';
  }

  renderTrendChart(data.dailyTimeline);
  renderTimeline(data.groupedTimeline);
  renderAccounts();
  renderReimbursements();
}

// --- Navigation Tabs -----------------------------------------------------

function initTabs() {
  const tabItems = document.querySelectorAll('.tab-item');
  const tabViews = document.querySelectorAll('.tab-view');
  const titleMap = {
    'tab-home':          'キャッシュフロー',
    'tab-accounts':      '資産・口座',
    'tab-reimbursement': '経費立替管理',
    'tab-settings':      '設定・バックアップ'
  };

  tabItems.forEach(item => {
    item.addEventListener('click', () => {
      const target = item.dataset.tab;

      tabItems.forEach(t => t.classList.remove('active'));
      item.classList.add('active');

      tabViews.forEach(v => v.classList.toggle('active', v.id === target));

      const titleEl = document.getElementById('app-title');
      titleEl.textContent = titleMap[target] || 'キャッシュフロー';

      // Always populate selectors and render to keep sync when tab switches
      populateAccountSelectors();
    });
  });
}

// --- Dialog Helpers ------------------------------------------------------

/** Populate <select> elements with account options */
function populateAccountSelectors() {
  const depositAccounts = state.accounts.filter(a => a.type !== 'credit');
  const creditCards     = state.accounts.filter(a => a.type === 'credit');

  const fillSelect = (id, accounts, addEmpty = false, emptyText = '(選択してください)') => {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = '';
    if (addEmpty) {
      el.appendChild(Object.assign(document.createElement('option'), { value: '', text: emptyText }));
    }
    for (const acc of accounts) {
      el.appendChild(Object.assign(document.createElement('option'), { value: acc.id, text: acc.name }));
    }
  };

  fillSelect('acc-linked-id',  depositAccounts, true, '(紐付けなし)');
  fillSelect('evt-account-id', depositAccounts);
  fillSelect('evt-card-id',    creditCards);
  fillSelect('sim-from',       depositAccounts);
  fillSelect('sim-to',         depositAccounts);
  fillSelect('inline-reim-account-id', depositAccounts);
}

/** Simple HTML escaping */
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// --- Dialog: Account -----------------------------------------------------
const dlgAccount  = document.getElementById('dlg-account');
const formAccount = document.getElementById('form-account');

function openAccountDialog(id = null) {
  populateAccountSelectors();
  const deleteBtn = document.getElementById('btn-delete-account');

  if (id) {
    const acc = state.accounts.find(a => a.id === id);
    if (!acc) return;

    document.getElementById('dlg-account-title').textContent = '口座の編集';
    document.getElementById('acc-id').value      = acc.id;
    document.getElementById('acc-type').value     = acc.type;
    document.getElementById('acc-name').value     = acc.name;
    document.getElementById('acc-balance').value  = acc.balance;
    document.getElementById('acc-linked-id').value   = acc.linkedAccountId || '';
    document.getElementById('acc-billing-day').value = acc.billingDay || '';
    deleteBtn.classList.remove('hidden');
  } else {
    document.getElementById('dlg-account-title').textContent = '口座の追加';
    formAccount.reset();
    document.getElementById('acc-id').value = '';
    deleteBtn.classList.add('hidden');
  }

  toggleAccountFields();
  dlgAccount.showModal();
}

function toggleAccountFields() {
  const type = document.getElementById('acc-type').value;
  const isCredit = type === 'credit';
  document.getElementById('grp-acc-balance').classList.toggle('hidden', isCredit);
  document.getElementById('grp-acc-link').classList.toggle('hidden', !isCredit);
  document.getElementById('grp-acc-billing-day').classList.toggle('hidden', !isCredit);
}

document.getElementById('acc-type').addEventListener('change', toggleAccountFields);

formAccount.addEventListener('submit', (e) => {
  e.preventDefault();
  const id         = document.getElementById('acc-id').value;
  const type       = document.getElementById('acc-type').value;
  const name       = document.getElementById('acc-name').value.trim();
  const balance    = Number(document.getElementById('acc-balance').value) || 0;
  const linkedId   = document.getElementById('acc-linked-id').value;
  const billingDay = Number(document.getElementById('acc-billing-day').value) || '';
  const isCredit   = type === 'credit';

  const payload = {
    id:              id || `acc-${Date.now()}`,
    type,
    name,
    balance:         isCredit ? 0 : balance,
    linkedAccountId: isCredit ? linkedId : '',
    billingDay:      isCredit ? billingDay : ''
  };

  if (id) {
    const idx = state.accounts.findIndex(a => a.id === id);
    if (idx !== -1) { state.accounts[idx] = payload; showToast('口座を更新しました'); }
  } else {
    state.accounts.push(payload);
    showToast('口座を追加しました');
  }

  saveState();
  renderApp();
  dlgAccount.close();
});

document.getElementById('btn-cancel-account').addEventListener('click', () => dlgAccount.close());
document.getElementById('btn-delete-account').addEventListener('click', () => {
  const id = document.getElementById('acc-id').value;
  if (!id) return;
  if (!confirm('この口座を削除しますか？紐づく予定データがある場合は、予測計算が正しく行われなくなる可能性があります。')) return;

  state.accounts = state.accounts.filter(a => a.id !== id);
  // Clean up dangling links
  for (const a of state.accounts) {
    if (a.linkedAccountId === id) a.linkedAccountId = '';
  }
  saveState();
  dlgAccount.close();
  setTimeout(() => {
    renderApp();
    showToast('口座を削除しました');
  }, 0);
});

// --- Dialog: Event -------------------------------------------------------
const dlgEvent  = document.getElementById('dlg-event');
const formEvent = document.getElementById('form-event');

function openEventDialog(id = null, defaultType = null) {
  populateAccountSelectors();
  const deleteBtn = document.getElementById('btn-delete-event');

  const now = new Date();
  const todayStr = formatDateLocal(now);
  const monthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  document.getElementById('evt-date').value = todayStr;
  document.getElementById('evt-reimbursement-month').value = monthStr;
  document.getElementById('evt-reimbursement-day').value = '10';

  if (id) {
    const evt = state.events.find(e => e.id === id);
    if (!evt) return;

    document.getElementById('dlg-event-title').textContent = '予定の編集';
    document.getElementById('evt-id').value        = evt.id;
    document.getElementById('evt-type').value       = evt.type;
    document.getElementById('evt-date').value       = evt.date;
    document.getElementById('evt-name').value       = evt.name;
    document.getElementById('evt-amount').value     = evt.amount;
    document.getElementById('evt-recurring').value  = evt.recurrence || 'none';

    if (evt.type === 'credit_bill') {
      document.getElementById('evt-card-id').value = evt.accountId;
    } else if (evt.type === 'reimbursement') {
      document.getElementById('evt-account-id').value = evt.accountId;
      document.getElementById('evt-reimbursement-month').value = evt.reimbursementMonth || monthStr;
      document.getElementById('evt-reimbursement-day').value   = evt.reimbursementDay || '10';
    } else {
      document.getElementById('evt-account-id').value = evt.accountId;
    }
    deleteBtn.classList.remove('hidden');
  } else {
    document.getElementById('dlg-event-title').textContent = '予定の追加';
    formEvent.reset();
    document.getElementById('evt-id').value = '';
    document.getElementById('evt-date').value = todayStr;
    document.getElementById('evt-reimbursement-month').value = monthStr;
    document.getElementById('evt-reimbursement-day').value = '10';
    if (defaultType) document.getElementById('evt-type').value = defaultType;
    deleteBtn.classList.add('hidden');
  }

  toggleEventFields();
  dlgEvent.showModal();
}

function toggleEventFields() {
  const type = document.getElementById('evt-type').value;
  const el = (id) => document.getElementById(id);

  el('grp-evt-card').classList.toggle('hidden', type !== 'credit_bill');
  el('grp-evt-account').classList.toggle('hidden', type === 'credit_bill');
  el('grp-evt-date').classList.toggle('hidden', type === 'reimbursement');
  el('grp-evt-reimbursement-month').classList.toggle('hidden', type !== 'reimbursement');
  el('grp-evt-reimbursement-day').classList.toggle('hidden', type !== 'reimbursement');

  el('evt-date').required = type !== 'reimbursement';

  if (type !== 'credit_bill') {
    el('lbl-evt-account-id').textContent =
      (type === 'income' || type === 'reimbursement') ? '入金先口座' : '出金口座';
  }
}

document.getElementById('evt-type').addEventListener('change', toggleEventFields);

formEvent.addEventListener('submit', (e) => {
  e.preventDefault();

  const id         = document.getElementById('evt-id').value;
  const type       = document.getElementById('evt-type').value;
  let date         = document.getElementById('evt-date').value;
  const name       = document.getElementById('evt-name').value.trim();
  const amount     = Number(document.getElementById('evt-amount').value) || 0;
  const recurrence = document.getElementById('evt-recurring').value;
  const isRecurring = recurrence !== 'none';

  const accountId = type === 'credit_bill'
    ? document.getElementById('evt-card-id').value
    : document.getElementById('evt-account-id').value;

  if (!accountId) {
    alert('対象口座/クレジットカードを選択してください');
    return;
  }

  let reimbursementMonth = '';
  let reimbursementDay   = '';

  if (type === 'reimbursement') {
    reimbursementMonth = document.getElementById('evt-reimbursement-month').value;
    reimbursementDay   = document.getElementById('evt-reimbursement-day').value;

    if (!reimbursementMonth) { alert('入金対象月を選択してください'); return; }

    const [yr, mo] = reimbursementMonth.split('-');
    if (reimbursementDay === 'end') {
      const lastDay = new Date(+yr, +mo, 0).getDate();
      date = `${yr}-${mo}-${String(lastDay).padStart(2, '0')}`;
    } else {
      date = `${yr}-${mo}-${String(reimbursementDay).padStart(2, '0')}`;
    }
  }

  const payload = {
    id: id || `evt-${Date.now()}`,
    name, type, amount, accountId, date,
    isRecurring, recurrence,
    reimbursementMonth, reimbursementDay
  };

  if (id) {
    const idx = state.events.findIndex(e => e.id === id);
    if (idx !== -1) { state.events[idx] = payload; showToast('予定を更新しました'); }
  } else {
    state.events.push(payload);
    showToast('予定を追加しました');
  }

  saveState();
  renderApp();
  dlgEvent.close();
});

document.getElementById('btn-cancel-event').addEventListener('click', () => dlgEvent.close());
document.getElementById('btn-delete-event').addEventListener('click', () => {
  const id = document.getElementById('evt-id').value;
  if (!id) return;
  if (!confirm('この予定を削除しますか？')) return;

  state.events = state.events.filter(e => e.id !== id);
  saveState();
  dlgEvent.close();
  setTimeout(() => {
    renderApp();
    showToast('予定を削除しました');
  }, 0);
});

// --- Dialog: Simulation --------------------------------------------------
const dlgSim  = document.getElementById('dlg-simulation');
const formSim = document.getElementById('form-simulation');

function openSimulationDialog(id = null) {
  populateAccountSelectors();
  const deleteBtn = document.getElementById('btn-delete-sim');
  const todayStr = formatDateLocal(new Date());

  document.getElementById('sim-date').value = todayStr;

  if (id) {
    const sim = state.simulations.find(s => s.id === id);
    if (!sim) return;

    document.getElementById('dlg-sim-title').textContent = 'シミュレーション編集';
    document.getElementById('sim-id').value        = sim.id;
    document.getElementById('sim-date').value       = sim.date;
    document.getElementById('sim-from').value       = sim.fromAccountId;
    document.getElementById('sim-to').value         = sim.toAccountId;
    document.getElementById('sim-amount').value     = sim.amount;
    document.getElementById('sim-recurring').value  = sim.recurrence || 'none';
    deleteBtn.classList.remove('hidden');
  } else {
    document.getElementById('dlg-sim-title').textContent = '資金移動シミュレーション追加';
    formSim.reset();
    document.getElementById('sim-id').value   = '';
    document.getElementById('sim-date').value = todayStr;
    deleteBtn.classList.add('hidden');
  }

  dlgSim.showModal();
}

formSim.addEventListener('submit', (e) => {
  e.preventDefault();

  const id            = document.getElementById('sim-id').value;
  const date          = document.getElementById('sim-date').value;
  const fromAccountId = document.getElementById('sim-from').value;
  const toAccountId   = document.getElementById('sim-to').value;
  const amount        = Number(document.getElementById('sim-amount').value) || 0;
  const recurrence    = document.getElementById('sim-recurring').value;
  const isRecurring   = recurrence !== 'none';

  if (fromAccountId === toAccountId) {
    alert('同じ口座間での資金移動はできません');
    return;
  }

  const payload = {
    id: id || `sim-${Date.now()}`,
    date, amount, fromAccountId, toAccountId, isRecurring, recurrence
  };

  if (id) {
    const idx = state.simulations.findIndex(s => s.id === id);
    if (idx !== -1) { state.simulations[idx] = payload; showToast('シミュレーションを更新しました'); }
  } else {
    state.simulations.push(payload);
    showToast('シミュレーションを追加しました');
  }

  saveState();
  renderApp();
  dlgSim.close();
});

document.getElementById('btn-cancel-sim').addEventListener('click', () => dlgSim.close());
document.getElementById('btn-delete-sim').addEventListener('click', () => {
  const id = document.getElementById('sim-id').value;
  if (!id) return;
  if (!confirm('このシミュレーションを削除しますか？')) return;

  state.simulations = state.simulations.filter(s => s.id !== id);
  saveState();
  dlgSim.close();
  setTimeout(() => {
    renderApp();
    showToast('シミュレーションを削除しました');
  }, 0);
});

// --- Light-Dismiss Fallback for Safari -----------------------------------

function registerLightDismissFallback(dialogEl) {
  if ('closedBy' in HTMLDialogElement.prototype) return;
  dialogEl.addEventListener('click', (e) => {
    if (e.target !== dialogEl) return;
    const rect = dialogEl.getBoundingClientRect();
    const inside =
      rect.top <= e.clientY && e.clientY <= rect.bottom &&
      rect.left <= e.clientX && e.clientX <= rect.right;
    if (!inside) dialogEl.close();
  });
}

const dlgFabMenu = document.getElementById('dlg-fab-menu');
[dlgAccount, dlgEvent, dlgSim, dlgFabMenu].forEach(registerLightDismissFallback);

// --- Backup / Restore / Screenshot ---------------------------------------

function exportBackupJSON() {
  const data = JSON.stringify({
    accounts:    state.accounts,
    events:      state.events,
    simulations: state.simulations
  }, null, 2);

  const blob = new Blob([data], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `cashflow_backup_${formatDateLocal(new Date())}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('バックアップファイルをダウンロードしました');
}

document.getElementById('btn-backup-json').addEventListener('click', exportBackupJSON);

document.getElementById('file-restore-json').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const parsed = JSON.parse(ev.target.result);
      if (!Array.isArray(parsed.accounts)) throw new Error('口座データが見つかりません');

      state.accounts    = parsed.accounts;
      state.events      = parsed.events || [];
      state.simulations = parsed.simulations || [];
      saveState();
      renderApp();
      showToast('データを正常に復元しました');
    } catch (err) {
      console.error('Restore error:', err);
      showToast('バックアップファイルの解析に失敗しました。', true);
    }
  };
  reader.readAsText(file);
  e.target.value = ''; // Reset so same file can be re-selected
});

document.getElementById('btn-clear-data').addEventListener('click', () => {
  if (!confirm('すべての登録データを初期化します。よろしいですか？（この操作は元に戻せません）')) return;
  localStorage.clear();
  seedDefaultData();
  renderApp();
  showToast('データを初期化し、初期状態にリセットしました');
});

// Screenshot via html2canvas
document.getElementById('btn-screenshot').addEventListener('click', () => {
  if (typeof html2canvas === 'undefined') {
    alert('画像エクスポートライブラリがロードされていません。オフラインの場合は、iPhoneの標準スクショ機能（電源ボタン＋音量ボタン）をご使用ください。');
    return;
  }

  showToast('画像生成中...');
  const target = document.querySelector('.app-content');

  html2canvas(target, {
    useCORS: true,
    allowTaint: true,
    backgroundColor: '#090d16',
    scrollY: -window.scrollY,
    windowWidth:  target.scrollWidth,
    windowHeight: target.scrollHeight
  }).then(canvas => {
    const a = document.createElement('a');
    a.href     = canvas.toDataURL('image/png');
    a.download = `cashflow_timeline_${formatDateLocal(new Date())}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    showToast('タイムライン画像を保存しました');
  }).catch(err => {
    console.error('Screenshot error:', err);
    showToast('スクリーンショット作成エラー', true);
  });
});

// --- Visibility Toggle ---------------------------------------------------

document.getElementById('btn-toggle-visibility').addEventListener('click', () => {
  state.hideBalance = !state.hideBalance;

  document.querySelector('.eye-icon').classList.toggle('hidden', state.hideBalance);
  document.querySelector('.eye-off-icon').classList.toggle('hidden', !state.hideBalance);

  saveState();
  renderApp();
  showToast(state.hideBalance ? '残高表示を非表示にしました' : '残高表示を表示にしました');
});

// --- Chart Collapse Toggle -----------------------------------------------

document.getElementById('btn-toggle-chart').addEventListener('click', () => {
  state.chartCollapsed = !state.chartCollapsed;

  document.getElementById('chart-wrapper').classList.toggle('collapsed', state.chartCollapsed);
  document.querySelector('#btn-toggle-chart .chevron-icon').classList.toggle('rotated', state.chartCollapsed);

  saveState();
  showToast(state.chartCollapsed ? 'グラフを折りたたみました' : 'グラフを表示しました');
});

// --- Timeline Range Filter -----------------------------------------------

document.getElementById('timeline-range').addEventListener('change', renderApp);

// --- FAB: Tap / Long-Press Handler ---------------------------------------

const fab = document.getElementById('fab-add-event');
let fabTimer = null;
let fabLongPressed = false;

function handleFabStart() {
  fabLongPressed = false;
  clearTimeout(fabTimer);
  fabTimer = setTimeout(() => { fabLongPressed = true; dlgFabMenu.showModal(); }, 400);
}

function handleFabEnd() {
  clearTimeout(fabTimer);
}

fab.addEventListener('touchstart', handleFabStart, { passive: true });
fab.addEventListener('touchend',   handleFabEnd,   { passive: true });
fab.addEventListener('mousedown',  handleFabStart);
fab.addEventListener('mouseup',    handleFabEnd);
fab.addEventListener('mouseleave', handleFabEnd);

fab.addEventListener('click', (e) => {
  if (fabLongPressed) { e.preventDefault(); fabLongPressed = false; return; }
  openEventDialog();
});

// FAB menu buttons
document.getElementById('menu-btn-add-event').addEventListener('click', () => {
  dlgFabMenu.close();
  openEventDialog();
});

document.getElementById('menu-btn-add-sim').addEventListener('click', () => {
  dlgFabMenu.close();
  openSimulationDialog();
});

document.getElementById('menu-btn-add-reimbursement').addEventListener('click', () => {
  dlgFabMenu.close();
  openEventDialog(null, 'reimbursement');
});

document.getElementById('btn-cancel-fab-menu').addEventListener('click', () => dlgFabMenu.close());

// --- Other Button Bindings -----------------------------------------------

document.getElementById('btn-add-account').addEventListener('click', () => openAccountDialog());
document.getElementById('btn-add-simulation').addEventListener('click', () => openSimulationDialog());

// --- Inline Reimbursement Form submission -------------------------------

document.getElementById('form-inline-reimbursement').addEventListener('submit', (e) => {
  e.preventDefault();
  
  const accountId = document.getElementById('inline-reim-account-id').value;
  const reimbursementMonth = document.getElementById('inline-reim-month').value;
  const reimbursementDay = document.getElementById('inline-reim-day').value;
  const name = document.getElementById('inline-reim-name').value.trim();
  const amount = Number(document.getElementById('inline-reim-amount').value) || 0;

  if (!accountId) {
    alert('入金先口座を選択してください');
    return;
  }
  if (!reimbursementMonth) {
    alert('入金対象月を選択してください');
    return;
  }

  let date = '';
  const [yr, mo] = reimbursementMonth.split('-');
  if (reimbursementDay === 'end') {
    const lastDay = new Date(+yr, +mo, 0).getDate();
    date = `${yr}-${mo}-${String(lastDay).padStart(2, '0')}`;
  } else {
    date = `${yr}-${mo}-${String(reimbursementDay).padStart(2, '0')}`;
  }

  const payload = {
    id: `evt-${Date.now()}`,
    name,
    type: 'reimbursement',
    amount,
    accountId,
    date,
    isRecurring: false,
    recurrence: 'none',
    reimbursementMonth,
    reimbursementDay
  };

  state.events.push(payload);
  saveState();
  renderApp();
  showToast('経費立替入金予定を追加しました');

  // Clear only name and amount to support fast succession inputting
  document.getElementById('inline-reim-name').value = '';
  document.getElementById('inline-reim-amount').value = '';
  
  // Set focus back to name
  document.getElementById('inline-reim-name').focus();
});

// --- Boot ----------------------------------------------------------------

window.addEventListener('DOMContentLoaded', () => {
  loadState();
  initTabs();

  // Restore UI state
  document.querySelector('.eye-icon').classList.toggle('hidden', state.hideBalance);
  document.querySelector('.eye-off-icon').classList.toggle('hidden', !state.hideBalance);

  if (state.chartCollapsed) {
    document.getElementById('chart-wrapper').classList.add('collapsed');
    document.querySelector('#btn-toggle-chart .chevron-icon').classList.add('rotated');
  }

  // Initialize inline month input to current month
  const now = new Date();
  const monthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const inlineMonthInput = document.getElementById('inline-reim-month');
  if (inlineMonthInput) {
    inlineMonthInput.value = monthStr;
  }

  // Toggle inline form container
  const btnToggleForm = document.getElementById('btn-toggle-inline-form');
  const inlineFormContainer = document.getElementById('inline-form-container');
  if (btnToggleForm && inlineFormContainer) {
    btnToggleForm.addEventListener('click', () => {
      inlineFormContainer.classList.toggle('hidden');
    });
  }

  // Cancel/Close button in inline form
  const btnCancelInlineReim = document.getElementById('btn-cancel-inline-reimbursement');
  if (btnCancelInlineReim && inlineFormContainer) {
    btnCancelInlineReim.addEventListener('click', () => {
      inlineFormContainer.classList.add('hidden');
    });
  }

  // Fill selectors with initial account options
  populateAccountSelectors();

  renderApp();
});
