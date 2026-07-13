/* Shahtaj order booker API explorer — mirrors Odoo booker flow for Flutter devs */
(function () {
  const STORAGE_KEY = 'shahtaj_api_test_v2';

  const ENDPOINT_CATALOG = [
    {
      path: '/api/shahtaj/v1/auth/login',
      purpose: 'Get API key',
      auth: false,
      params: [
        { name: 'database', required: true, type: 'string' },
        { name: 'login', required: true, type: 'string' },
        { name: 'password', required: true, type: 'string' },
      ],
    },
    {
      path: '/api/shahtaj/v1/auth/me',
      purpose: 'Validate session',
      auth: true,
      params: [],
    },
    {
      path: '/api/shahtaj/v1/tasks/today',
      purpose: 'List today tasks',
      auth: true,
      params: [],
    },
    {
      path: '/api/shahtaj/v1/tasks/check-in',
      purpose: 'GPS start visit',
      auth: true,
      params: [
        { name: 'task_id', required: true, type: 'int' },
        { name: 'latitude', required: true, type: 'float' },
        { name: 'longitude', required: true, type: 'float' },
      ],
    },
    {
      path: '/api/shahtaj/v1/tasks/skip',
      purpose: 'Skip shop visit',
      auth: true,
      params: [{ name: 'task_id', required: true, type: 'int' }],
    },
    {
      path: '/api/shahtaj/v1/tasks/notes',
      purpose: 'Save task notes',
      auth: true,
      params: [
        { name: 'task_id', required: true, type: 'int' },
        { name: 'notes', required: false, type: 'string' },
      ],
    },
    {
      path: '/api/shahtaj/v1/visits/active',
      purpose: 'Resume open visit',
      auth: true,
      params: [],
    },
    {
      path: '/api/shahtaj/v1/visits/mine',
      purpose: 'Past visits list',
      auth: true,
      params: [
        { name: 'limit', required: false, type: 'int', default: '50' },
        { name: 'offset', required: false, type: 'int', default: '0' },
        { name: 'date_from', required: false, type: 'string', note: 'YYYY-MM-DD' },
        { name: 'date_to', required: false, type: 'string', note: 'YYYY-MM-DD' },
      ],
    },
    {
      path: '/api/shahtaj/v1/visits/get',
      purpose: 'Visit full detail',
      auth: true,
      params: [{ name: 'visit_id', required: true, type: 'int' }],
    },
    {
      path: '/api/shahtaj/v1/visits/line/add',
      purpose: 'Add cart product',
      auth: true,
      params: [
        { name: 'visit_id', required: true, type: 'int' },
        { name: 'product_id', required: true, type: 'int' },
        { name: 'quantity', required: false, type: 'float', default: '1' },
      ],
    },
    {
      path: '/api/shahtaj/v1/visits/line/update',
      purpose: 'Update cart line',
      auth: true,
      params: [
        { name: 'line_id', required: true, type: 'int' },
        { name: 'quantity', required: false, type: 'float' },
        { name: 'price_unit', required: false, type: 'float' },
      ],
    },
    {
      path: '/api/shahtaj/v1/visits/line/remove',
      purpose: 'Remove cart line',
      auth: true,
      params: [{ name: 'line_id', required: true, type: 'int' }],
    },
    {
      path: '/api/shahtaj/v1/visits/place-order',
      purpose: 'Submit sales order',
      auth: true,
      params: [{ name: 'visit_id', required: true, type: 'int' }],
    },
    {
      path: '/api/shahtaj/v1/visits/end-without-order',
      purpose: 'Close empty visit',
      auth: true,
      params: [
        { name: 'visit_id', required: true, type: 'int' },
        { name: 'notes', required: true, type: 'string', note: 'Reason required' },
      ],
    },
    {
      path: '/api/shahtaj/v1/visits/notes',
      purpose: 'Save visit notes',
      auth: true,
      params: [
        { name: 'visit_id', required: true, type: 'int' },
        { name: 'notes', required: false, type: 'string' },
      ],
    },
    {
      path: '/api/shahtaj/v1/products/list',
      purpose: 'List sellable products',
      auth: true,
      params: [
        { name: 'visit_id', required: false, type: 'int', note: 'Adjusts qty_bookable for active visit cart' },
        { name: 'limit', required: false, type: 'int', default: '500' },
        { name: 'offset', required: false, type: 'int', default: '0' },
      ],
    },
    {
      path: '/api/shahtaj/v1/schedule/weekly',
      purpose: 'Weekly route plan',
      auth: true,
      params: [],
    },
    {
      path: '/api/shahtaj/v1/targets/mine',
      purpose: 'List sales targets',
      auth: true,
      params: [],
    },
    {
      path: '/api/shahtaj/v1/zones/list',
      purpose: 'Zone picker for shop registration',
      auth: true,
      params: [],
    },
    {
      path: '/api/shahtaj/v1/routes/list',
      purpose: 'Route picker (filter by zone)',
      auth: true,
      params: [
        { name: 'zone_id', required: false, type: 'int', note: 'When set, only routes in that zone' },
      ],
    },
    {
      path: '/api/shahtaj/v1/shops/register',
      purpose: 'Register new shop',
      auth: true,
      params: [
        { name: 'name', required: true, type: 'string' },
        { name: 'owner_name', required: true, type: 'string' },
        { name: 'owner_phone', required: true, type: 'string' },
        { name: 'owner_cnic_number', required: false, type: 'string' },
        { name: 'latitude', required: true, type: 'float' },
        { name: 'longitude', required: true, type: 'float' },
        { name: 'zone_id', required: false, type: 'int' },
        { name: 'route_id', required: false, type: 'int' },
        { name: 'credit_limit', required: false, type: 'float' },
        { name: 'legacy_balance', required: false, type: 'float' },
        { name: 'shop_category', required: false, type: 'string', note: 'Read-only in API response; set by distributor (credit|cash). Defaults to credit on register.' },
        { name: 'owner_cnic_front', required: false, type: 'base64' },
        { name: 'owner_cnic_back', required: false, type: 'base64' },
        { name: 'owner_photo', required: false, type: 'base64' },
        { name: 'shop_exterior_photo', required: false, type: 'base64' },
      ],
    },
    {
      path: '/api/shahtaj/v1/shops/mine',
      purpose: 'My registered shops',
      auth: true,
      params: [],
    },
    {
      path: '/api/shahtaj/v1/shops/get',
      purpose: 'Shop registration detail',
      auth: true,
      params: [
        { name: 'shop_id', required: true, type: 'int' },
        { name: 'include_photos', required: false, type: 'bool', default: 'true' },
      ],
    },
  ];

  const state = {
    apiKey: null,
    database: null,
    user: null,
    onlineStatus: null,
    tasks: [],
    selectedTask: null,
    visit: null,
    lastCompletedVisit: null,
    products: [],
  };

  const $ = (id) => document.getElementById(id);

  const IMAGE_FIELD_RE = /photo|cnic|image/i;

  function sanitizeBodyForLog(body) {
    if (!body || typeof body !== 'object') return body || {};
    const out = {};
    Object.entries(body).forEach(([key, value]) => {
      if (typeof value === 'string' && (IMAGE_FIELD_RE.test(key) || value.startsWith('data:image'))) {
        out[key] = `<base64 image, ${value.length} chars>`;
      } else {
        out[key] = value;
      }
    });
    return out;
  }

  function catalogForPath(path) {
    return ENDPOINT_CATALOG.find((e) => e.path === path);
  }

  function logEntry(path, body, result) {
    const el = $('api-log');
    const time = new Date().toLocaleTimeString();
    const catalog = catalogForPath(path);
    const wrap = document.createElement('div');
    wrap.className = `log-entry ${result.kind}`;

    let html = `<div class="log-time">[${time}] POST ${path}</div>`;
    if (catalog && catalog.purpose) {
      html += `<div class="log-meta purpose-tag">${escapeHtml(catalog.purpose)}</div>`;
    }
    html += `<div class="log-meta">Auth: ${path.includes('/auth/login') ? 'none (login)' : 'Bearer token'}</div>`;

    if (catalog && catalog.params.length) {
      html += '<div class="log-section-title">Expected params</div><ul class="log-params">';
      catalog.params.forEach((p) => {
        const req = p.required ? 'required' : 'optional';
        const def = p.default ? `, default ${p.default}` : '';
        const note = p.note ? ` — ${p.note}` : '';
        html += `<li><code>${p.name}</code> <span class="muted">(${req}, ${p.type}${def})${note}</span></li>`;
      });
      html += '</ul>';
    } else if (catalog) {
      html += '<div class="log-meta muted">No body params — Bearer token only</div>';
    }

    html += '<div class="log-section-title">Request body</div>';
    html += `<pre class="log-json">${escapeHtml(JSON.stringify(sanitizeBodyForLog(body || {}), null, 2))}</pre>`;

    html += `<div class="log-section-title">${result.kind === 'ok' ? 'Response' : 'Error'}</div>`;
    html += `<pre class="log-json">${escapeHtml(JSON.stringify(result.data, null, 2))}</pre>`;

    wrap.innerHTML = html;
    el.prepend(wrap);
  }

  function escapeHtml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function renderApiQuickIndex() {
    const el = $('api-quick-index');
    if (!el) return;
    let html = '<h3>API index <span class="muted">(three-word purpose)</span></h3>';
    html += '<ol class="api-index-list">';
    ENDPOINT_CATALOG.forEach((ep) => {
      html += `<li>
        <span class="api-purpose">${escapeHtml(ep.purpose)}</span>
        <code class="api-path">${ep.path}</code>
        <span class="muted">${ep.auth ? 'Bearer' : 'login'}</span>
      </li>`;
    });
    html += '</ol>';
    el.innerHTML = html;
  }

  function renderEndpointReference() {
    const el = $('endpoint-reference');
    let html = '<h3>Endpoint reference (all POST, JSON body)</h3>';
    html += '<p class="hint">Success envelope: <code>{ "ok": true, "data": { ... } }</code>. Every call except <code>auth/login</code> needs <code>Authorization: Bearer &lt;api_key&gt;</code>.</p>';
    html += '<table class="ref-table"><thead><tr><th>Purpose</th><th>Endpoint</th><th>Auth</th><th>Body params</th></tr></thead><tbody>';
    ENDPOINT_CATALOG.forEach((ep) => {
      const params = ep.params.length
        ? ep.params.map((p) => {
            const mark = p.required ? '*' : '';
            const def = p.default ? ` = ${p.default}` : '';
            const note = p.note ? ` — ${p.note}` : '';
            return `<code>${p.name}${mark}</code> (${p.type}${def})${note}`;
          }).join('<br/>')
        : '<span class="muted">{} empty</span>';
      html += `<tr>
        <td><strong>${escapeHtml(ep.purpose)}</strong></td>
        <td><code>${ep.path}</code></td>
        <td>${ep.auth ? 'Bearer' : '—'}</td>
        <td>${params}</td>
      </tr>`;
    });
    html += '</tbody></table><p class="hint">* = required</p>';
    el.innerHTML = html;
  }

  function saveSession() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      apiKey: state.apiKey,
      database: state.database,
      user: state.user,
    }));
  }

  function showApp() {
    $('screen-login').classList.add('hidden');
    $('screen-app').classList.remove('hidden');
    $('header-user').classList.remove('hidden');
    const userLabel = state.user
      ? `${state.user.name} (${state.user.login})`
      : 'Connected';
    $('session-user').textContent = userLabel;
    const pill = $('session-status');
    if (state.onlineStatus) {
      pill.textContent = state.onlineStatus;
      pill.className = `status-pill status-${state.onlineStatus}`;
      pill.classList.remove('hidden');
    } else {
      pill.classList.add('hidden');
    }
  }

  function showLogin() {
    $('screen-app').classList.add('hidden');
    $('screen-login').classList.remove('hidden');
    $('header-user').classList.add('hidden');
  }

  function clearSession() {
    state.apiKey = null;
    state.user = null;
    state.onlineStatus = null;
    state.tasks = [];
    state.selectedTask = null;
    state.visit = null;
    state.lastCompletedVisit = null;
    localStorage.removeItem(STORAGE_KEY);
    showLogin();
    $('login-status').textContent = 'Logged out.';
    $('login-status').className = 'status';
  }

  async function api(path, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (state.apiKey) headers.Authorization = `Bearer ${state.apiKey}`;
    if (state.database) headers['X-Odoo-Database'] = state.database;

    const requestBody = body || {};

    let res;
    try {
      res = await fetch(path, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        credentials: 'omit',
      });
    } catch (e) {
      logEntry(path, requestBody, { kind: 'err', data: { message: e.message } });
      throw new Error(
        'Cannot reach server. Is Odoo running on this host? (' + e.message + ')'
      );
    }

    let payload;
    const text = await res.text();
    try {
      payload = text ? JSON.parse(text) : {};
    } catch (e) {
      payload = { message: text };
    }

    if (!res.ok) {
      logEntry(path, requestBody, { kind: 'err', data: payload });
      throw new Error(payload.message || payload.name || res.statusText);
    }

    const data = payload.data !== undefined ? payload.data : payload;
    logEntry(path, requestBody, { kind: 'ok', data });
    return data;
  }

  /* ── Tabs ── */
  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      $(`tab-${btn.dataset.tab}`).classList.add('active');
      onTabShow(btn.dataset.tab);
    });
  });

  async function onTabShow(tab) {
    if (!state.apiKey) return;
    if (tab === 'tasks') await loadTasks();
    if (tab === 'visit') await loadActiveVisit();
    if (tab === 'history') await loadVisitHistory();
    if (tab === 'schedule') await loadSchedule();
    if (tab === 'targets') await loadTargets();
    if (tab === 'shops') {
      await loadZonePicker();
      await loadMyShops();
    }
  }

  async function loadZonePicker() {
    const zoneSelect = $('reg-zone');
    const routeSelect = $('reg-route');
    zoneSelect.innerHTML = '<option value="">— Select zone —</option>';
    routeSelect.innerHTML = '<option value="">— Select route —</option>';
    routeSelect.disabled = true;
    try {
      const data = await api('/api/shahtaj/v1/zones/list', {});
      (data.zones || []).forEach((zone) => {
        const opt = document.createElement('option');
        opt.value = zone.id;
        opt.textContent = `${zone.name} (${zone.route_count} routes)`;
        zoneSelect.appendChild(opt);
      });
    } catch (e) {
      console.warn('zones/list failed', e);
    }
  }

  async function loadRoutePicker(zoneId) {
    const routeSelect = $('reg-route');
    routeSelect.innerHTML = '<option value="">— Select route —</option>';
    if (!zoneId) {
      routeSelect.disabled = true;
      return;
    }
    routeSelect.disabled = false;
    try {
      const data = await api('/api/shahtaj/v1/routes/list', { zone_id: parseInt(zoneId, 10) });
      (data.routes || []).forEach((route) => {
        const opt = document.createElement('option');
        opt.value = route.id;
        opt.textContent = `${route.name} (${route.shop_count} shops)`;
        routeSelect.appendChild(opt);
      });
    } catch (e) {
      console.warn('routes/list failed', e);
    }
  }

  $('reg-zone').addEventListener('change', () => {
    loadRoutePicker($('reg-zone').value).catch(console.warn);
  });

  function switchTab(name) {
    const btn = document.querySelector(`.tab[data-tab="${name}"]`);
    if (btn) btn.click();
  }

  function alertErr(e) {
    alert(e.message || String(e));
  }

  /* ── Login ── */
  $('btn-login').onclick = async () => {
    const database = $('inp-database').value.trim();
    const login = $('inp-login').value.trim();
    const password = $('inp-password').value;
    $('login-status').textContent = 'Logging in...';
    $('login-status').className = 'status';
    try {
      const data = await api('/api/shahtaj/v1/auth/login', { database, login, password });
      state.apiKey = data.api_key;
      state.database = data.database;
      state.user = data.user;
      saveSession();
      const me = await api('/api/shahtaj/v1/auth/me', {});
      state.onlineStatus = me.online_status;
      showApp();
      $('login-status').textContent = `Logged in as ${data.user.name}`;
      $('login-status').className = 'status ok';
      await loadTasks();
      await loadActiveVisit();
    } catch (e) {
      $('login-status').textContent = e.message;
      $('login-status').className = 'status err';
    }
  };

  $('btn-logout').onclick = clearSession;

  /* ── Tasks ── */
  async function loadTasks() {
    const data = await api('/api/shahtaj/v1/tasks/today', {});
    state.tasks = data.tasks || [];
    $('tasks-date').textContent = `Date: ${data.date} — ${state.tasks.length} task(s)`;
    renderTaskCards();
  }

  function renderTaskCards() {
    const el = $('task-cards');
    if (!state.tasks.length) {
      el.innerHTML = '<p class="empty-state">No tasks for today.</p>';
      return;
    }
    el.innerHTML = state.tasks.map((t) => {
      const shop = t.shop || {};
      return `<article class="card task-card" data-task-id="${t.id}">
        <h4>${escapeHtml(shop.name || '?')} <span class="meta">#${shop.shop_id || shop.id || ''}</span></h4>
        <p class="meta">${escapeHtml(t.route?.name || '')} · ${t.state} · Booker ID: ${t.order_booker_id || '?'}</p>
        <p class="hint">${escapeHtml(shop.owner_phone || '')}</p>
      </article>`;
    }).join('');
    el.querySelectorAll('.task-card').forEach((card) => {
      card.onclick = () => selectTask(parseInt(card.dataset.taskId, 10));
    });
  }

  function selectTask(taskId) {
    state.selectedTask = state.tasks.find((t) => t.id === taskId) || null;
    const panel = $('checkin-panel');
    if (!state.selectedTask) {
      panel.classList.add('hidden');
      return;
    }
    panel.classList.remove('hidden');
    const shop = state.selectedTask.shop || {};
    $('selected-task-label').textContent =
      `${shop.name} (Shop ID: ${shop.shop_id || shop.id}) — ${state.selectedTask.state}`;
    $('inp-task-notes').value = state.selectedTask.notes || '';
    const gpsBox = $('shop-gps-box');
    gpsBox.innerHTML = shop.latitude && shop.longitude
      ? `Shop GPS: ${shop.latitude}, ${shop.longitude} · approval: ${shop.approval_state}`
      : '<span class="warn">Shop has no GPS — check-in will fail.</span>';
    const hasVisit = !!state.selectedTask.visit_id;
    $('btn-checkin').classList.toggle('hidden', hasVisit);
    $('btn-continue-visit').classList.toggle('hidden', !hasVisit);
  }

  $('btn-refresh-tasks').onclick = () => loadTasks().catch(alertErr);

  $('btn-use-shop-gps').onclick = () => {
    if (!state.selectedTask?.shop) return;
    $('inp-lat').value = state.selectedTask.shop.latitude || '';
    $('inp-lng').value = state.selectedTask.shop.longitude || '';
  };

  $('btn-use-device-gps').onclick = () => {
    if (!navigator.geolocation) {
      alert('Geolocation not available in this browser.');
      return;
    }
    navigator.geolocation.getCurrentPosition((pos) => {
      $('inp-lat').value = pos.coords.latitude;
      $('inp-lng').value = pos.coords.longitude;
    }, (err) => alert(err.message));
  };

  $('btn-checkin').onclick = async () => {
    if (!state.selectedTask) return;
    try {
      const data = await api('/api/shahtaj/v1/tasks/check-in', {
        task_id: state.selectedTask.id,
        latitude: parseFloat($('inp-lat').value),
        longitude: parseFloat($('inp-lng').value),
      });
      state.visit = data.visit;
      if (data.resumed) alert('Resumed existing visit for this task.');
      switchTab('visit');
      renderVisit();
      await loadTasks();
    } catch (e) {
      alert(e.message);
    }
  };

  $('btn-continue-visit').onclick = async () => {
    if (!state.selectedTask?.visit_id) return;
    try {
      const data = await api('/api/shahtaj/v1/visits/get', {
        visit_id: state.selectedTask.visit_id,
      });
      state.visit = data.visit;
      switchTab('visit');
      renderVisit();
    } catch (e) {
      alert(e.message);
    }
  };

  $('btn-skip-task').onclick = async () => {
    if (!state.selectedTask) return;
    if (!confirm('Skip this task without visiting?')) return;
    try {
      await api('/api/shahtaj/v1/tasks/skip', { task_id: state.selectedTask.id });
      await loadTasks();
      $('checkin-panel').classList.add('hidden');
    } catch (e) {
      alert(e.message);
    }
  };

  $('btn-save-task-notes').onclick = async () => {
    if (!state.selectedTask) return;
    try {
      const data = await api('/api/shahtaj/v1/tasks/notes', {
        task_id: state.selectedTask.id,
        notes: $('inp-task-notes').value,
      });
      state.selectedTask = data.task;
      await loadTasks();
      alert('Task notes saved.');
    } catch (e) {
      alert(e.message);
    }
  };

  /* ── Visit ── */
  async function loadActiveVisit() {
    const data = await api('/api/shahtaj/v1/visits/active', {});
    state.visit = data.visit;
    renderVisit();
  }

  function renderVisit() {
    const empty = $('visit-empty');
    const content = $('visit-content');
    const completed = $('visit-completed');
    if (state.visit && state.visit.state === 'in_progress') {
      empty.classList.add('hidden');
      content.classList.remove('hidden');
      completed.classList.add('hidden');
      const v = state.visit;
      $('visit-summary').innerHTML = `
        <p><strong>${escapeHtml(v.shop?.name || '')}</strong> <span class="meta">(Shop ID: ${v.shop_id || v.shop?.id || '?'})</span> · ${v.state} · ${v.duration_minutes?.toFixed?.(1) || 0} min</p>
        <p class="meta">Booker ID: ${v.order_booker_id || '?'} · Check-in distance: ${v.check_in_distance_m?.toFixed?.(0) || '?'} m</p>`;
      $('inp-visit-notes').value = v.notes || '';
      const tbody = $('visit-lines-table').querySelector('tbody');
      tbody.innerHTML = (v.lines || []).map((line) => `
        <tr>
          <td>${escapeHtml(line.product?.name || '')}</td>
          <td>${line.quantity}</td>
          <td>${line.price_unit}</td>
          <td>${line.subtotal}</td>
          <td>
            <button class="ghost sm" data-line-update="${line.id}">Edit qty</button>
            <button class="ghost sm" data-line-remove="${line.id}">Remove</button>
          </td>
        </tr>`).join('');
      tbody.querySelectorAll('[data-line-update]').forEach((btn) => {
        btn.onclick = async () => {
          const qty = prompt('New quantity:', '1');
          if (!qty) return;
          try {
            const data = await api('/api/shahtaj/v1/visits/line/update', {
              line_id: parseInt(btn.dataset.lineUpdate, 10),
              quantity: parseFloat(qty),
            });
            state.visit = data.visit;
            renderVisit();
          } catch (e) {
            alert(e.message);
          }
        };
      });
      tbody.querySelectorAll('[data-line-remove]').forEach((btn) => {
        btn.onclick = async () => {
          try {
            const data = await api('/api/shahtaj/v1/visits/line/remove', {
              line_id: parseInt(btn.dataset.lineRemove, 10),
            });
            state.visit = data.visit;
            renderVisit();
          } catch (e) {
            alert(e.message);
          }
        };
      });
    } else {
      content.classList.add('hidden');
      if (state.lastCompletedVisit) {
        empty.classList.add('hidden');
        completed.classList.remove('hidden');
        const v = state.lastCompletedVisit;
        $('visit-completed-body').innerHTML = `
          <p>Outcome: <strong>${v.outcome}</strong></p>
          <p>Order: ${escapeHtml(v.sale_order_name || '—')} · ${v.order_amount || 0}</p>
          <p>Notes: ${escapeHtml(v.notes || '')}</p>`;
      } else {
        empty.classList.remove('hidden');
        completed.classList.add('hidden');
      }
    }
  }

  async function loadVisitHistory() {
    const body = { limit: 50, offset: 0 };
    const dateFrom = $('hist-date-from')?.value;
    const dateTo = $('hist-date-to')?.value;
    if (dateFrom) body.date_from = dateFrom;
    if (dateTo) body.date_to = dateTo;
    const data = await api('/api/shahtaj/v1/visits/mine', body);
    const el = $('history-list');
    const visits = data.visits || [];
    if (!visits.length) {
      el.innerHTML = '<p class="empty-state">No past visits.</p>';
      return;
    }
    el.innerHTML = `<p class="meta">Showing ${visits.length} of ${data.total || visits.length}</p>` +
      visits.map((v) => `
        <article class="card history-card" data-visit-id="${v.id}">
          <h4>${escapeHtml(v.shop?.name || '?')} <span class="meta">#${v.shop_id || v.shop?.id || ''}</span></h4>
          <p>${v.outcome} · ${v.started_at || ''} · Booker ID: ${v.order_booker_id || '?'}</p>
          <p class="hint">Order: ${escapeHtml(v.sale_order_name || '—')}</p>
        </article>`).join('');
    el.querySelectorAll('.history-card').forEach((card) => {
      card.onclick = async () => {
        try {
          await api('/api/shahtaj/v1/visits/get', {
            visit_id: parseInt(card.dataset.visitId, 10),
          });
        } catch (e) {
          alert(e.message);
        }
      };
    });
  }

  async function loadSchedule() {
    const data = await api('/api/shahtaj/v1/schedule/weekly', {});
    const el = $('schedule-list');
    const rows = data.schedules || [];
    if (!rows.length) {
      el.innerHTML = '<p class="empty-state">No weekly schedule.</p>';
      return;
    }
    el.innerHTML = rows.map((s) => `
      <article class="card">
        <h4>${escapeHtml(s.day_label)} — ${escapeHtml(s.route?.name || '')}</h4>
        <p>${s.shop_count} shops · progress ${s.week_tasks_progress?.toFixed?.(0) || 0}%</p>
      </article>`).join('');
  }

  async function loadTargets() {
    const data = await api('/api/shahtaj/v1/targets/mine', {});
    const el = $('targets-list');
    const rows = data.targets || [];
    if (!rows.length) {
      el.innerHTML = '<p class="empty-state">No active targets.</p>';
      return;
    }
    el.innerHTML = rows.map((t) => {
      const unit = t.target_weight_uom ? ` ${t.target_weight_uom}` : '';
      const remaining = t.target_type === 'product_weight' && t.remaining_value != null
        ? ` · ${t.remaining_value}${unit} left`
        : '';
      return `
      <article class="card">
        <h4>${escapeHtml(t.name)}</h4>
        <p>${t.date_start} → ${t.date_end}</p>
        <p>${t.achieved_value}${unit} / ${t.target_value}${unit} (${t.progress_percent?.toFixed?.(0) || 0}%)${remaining}</p>
      </article>`;
    }).join('');
  }

  async function loadMyShops() {
    const data = await api('/api/shahtaj/v1/shops/mine', {});
    const el = $('shops-list');
    const shops = data.shops || [];
    if (!shops.length) {
      el.innerHTML = '<p class="empty-state">No registered shops yet.</p>';
      return;
    }
    el.innerHTML = shops.map((s) => `
      <article class="card shop-card" data-shop-id="${s.id}">
        <h4>${escapeHtml(s.name)} <span class="meta">#${s.shop_id || s.id}</span></h4>
        <p>${s.approval_state} · ${escapeHtml(s.owner_phone || '')}</p>
      </article>`).join('');
    el.querySelectorAll('.shop-card').forEach((card) => {
      card.onclick = async () => {
        try {
          const detail = await api('/api/shahtaj/v1/shops/get', {
            shop_id: parseInt(card.dataset.shopId, 10),
            include_photos: true,
          });
          $('shop-detail-panel').classList.remove('hidden');
          $('shop-detail-title').textContent = `${detail.shop.name} (Shop ID: ${detail.shop.shop_id || detail.shop.id})`;
          $('shop-detail-photos').innerHTML = '<pre class="log-json">' +
            escapeHtml(JSON.stringify(detail.shop.photo_data || {}, null, 2)) + '</pre>';
        } catch (e) {
          alert(e.message);
        }
      };
    });
  }

  $('btn-refresh-visit').onclick = () => loadActiveVisit().catch(alertErr);
  $('btn-refresh-history').onclick = () => loadVisitHistory().catch(alertErr);
  $('btn-refresh-schedule').onclick = () => loadSchedule().catch(alertErr);
  $('btn-refresh-targets').onclick = () => loadTargets().catch(alertErr);
  $('btn-refresh-shops').onclick = () => loadMyShops().catch(alertErr);

  $('btn-load-products').onclick = async () => {
    if (!state.visit) {
      alert('No active visit.');
      return;
    }
    try {
      const data = await api('/api/shahtaj/v1/products/list', {
        visit_id: state.visit.id,
        limit: 500,
      });
      state.products = data.products || [];
      $('products-meta').textContent = `${state.products.length} of ${data.total} products loaded`;
      renderProductCards();
    } catch (e) {
      alert(e.message);
    }
  };

  function renderProductCards() {
    const filter = ($('inp-product-filter').value || '').toLowerCase();
    const qty = parseFloat($('inp-add-qty').value) || 1;
    const el = $('product-cards');
    const list = state.products.filter((p) =>
      !filter || (p.name || '').toLowerCase().includes(filter)
    );
    el.innerHTML = list.map((p) => `
      <article class="card product-card compact-card">
        <h4>${escapeHtml(p.name)}</h4>
        <p>${p.list_price} · ${escapeHtml(p.uom || '')}</p>
        <p class="hint">${p.qty_unlimited ? 'Unlimited' : `Bookable: ${p.qty_bookable}`}</p>
        <button class="secondary sm" data-product-id="${p.id}">Add</button>
      </article>`).join('');
    el.querySelectorAll('[data-product-id]').forEach((btn) => {
      btn.onclick = async () => {
        try {
          const data = await api('/api/shahtaj/v1/visits/line/add', {
            visit_id: state.visit.id,
            product_id: parseInt(btn.dataset.productId, 10),
            quantity: qty,
          });
          state.visit = data.visit;
          renderVisit();
        } catch (e) {
          alert(e.message);
        }
      };
    });
  }

  $('inp-product-filter').oninput = renderProductCards;

  $('btn-save-visit-notes').onclick = async () => {
    if (!state.visit) return;
    try {
      const data = await api('/api/shahtaj/v1/visits/notes', {
        visit_id: state.visit.id,
        notes: $('inp-visit-notes').value,
      });
      state.visit = data.visit;
      alert('Visit notes saved.');
    } catch (e) {
      alert(e.message);
    }
  };

  $('btn-place-order').onclick = async () => {
    if (!state.visit) return;
    if (!confirm('Place order from cart lines?')) return;
    try {
      const data = await api('/api/shahtaj/v1/visits/place-order', {
        visit_id: state.visit.id,
      });
      state.lastCompletedVisit = data.visit;
      state.visit = null;
      renderVisit();
      await loadTasks();
      alert(`Order placed: ${data.visit.sale_order_name || 'OK'} — Total: ${data.visit.order_amount}`);
    } catch (e) {
      alert(e.message);
    }
  };

  $('btn-end-visit').onclick = async () => {
    if (!state.visit) return;
    const notes = ($('inp-visit-notes').value || '').trim();
    if (!notes) {
      alert('Please enter a reason in Visit notes before ending without order.');
      $('inp-visit-notes').focus();
      return;
    }
    if (!confirm('End visit without order?')) return;
    try {
      const data = await api('/api/shahtaj/v1/visits/end-without-order', {
        visit_id: state.visit.id,
        notes,
      });
      state.lastCompletedVisit = data.visit;
      state.visit = null;
      renderVisit();
      await loadTasks();
    } catch (e) {
      alert(e.message);
    }
  };

  $('btn-view-completed-visit').onclick = async () => {
    if (!state.lastCompletedVisit) return;
    try {
      await api('/api/shahtaj/v1/visits/get', { visit_id: state.lastCompletedVisit.id });
    } catch (e) {
      alert(e.message);
    }
  };

  async function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  document.querySelectorAll('input[type=file][data-preview]').forEach((input) => {
    input.addEventListener('change', async () => {
      const preview = $(input.dataset.preview);
      if (!input.files?.[0]) {
        preview.classList.add('hidden');
        return;
      }
      preview.src = await fileToBase64(input.files[0]);
      preview.classList.remove('hidden');
    });
  });

  $('btn-register-shop').onclick = async () => {
    const body = {
      name: $('reg-name').value.trim(),
      owner_name: $('reg-owner').value.trim(),
      owner_phone: $('reg-phone').value.trim(),
      latitude: parseFloat($('reg-lat').value),
      longitude: parseFloat($('reg-lng').value),
    };
    const ownerCnicNumber = $('reg-owner-cnic-number').value.trim();
    if (ownerCnicNumber) body.owner_cnic_number = ownerCnicNumber;
    const credit = $('reg-credit').value;
    const legacy = $('reg-legacy').value;
    const zone = $('reg-zone').value;
    const route = $('reg-route').value;
    if (credit) body.credit_limit = parseFloat(credit);
    if (legacy) body.legacy_balance = parseFloat(legacy);
    if (zone) body.zone_id = parseInt(zone, 10);
    if (route) body.route_id = parseInt(route, 10);
    const photoFields = [
      ['reg-cnic-front', 'owner_cnic_front'],
      ['reg-cnic-back', 'owner_cnic_back'],
      ['reg-owner-photo', 'owner_photo'],
      ['reg-shop-exterior', 'shop_exterior_photo'],
    ];
    for (const [inputId, field] of photoFields) {
      const file = $(inputId).files?.[0];
      if (file) body[field] = await fileToBase64(file);
    }
    try {
      await api('/api/shahtaj/v1/shops/register', body);
      alert('Shop submitted for approval.');
      await loadMyShops();
    } catch (e) {
      alert(e.message);
    }
  };

  $('btn-clear-log').onclick = () => {
    $('api-log').innerHTML = '';
  };

  /* ── Boot ── */
  renderApiQuickIndex();
  renderEndpointReference();

  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      if (parsed.apiKey) {
        state.apiKey = parsed.apiKey;
        state.database = parsed.database;
        state.user = parsed.user;
        $('inp-database').value = parsed.database || 'shahtaj_dev19';
        api('/api/shahtaj/v1/auth/me', {})
          .then((me) => {
            state.onlineStatus = me.online_status;
            showApp();
            loadTasks();
            loadActiveVisit();
          })
          .catch(clearSession);
      }
    } catch (e) {
      clearSession();
    }
  }
})();
